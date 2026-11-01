import { mergeWorkouts } from './apple-health.mjs';
import { checkInNotification } from './notification.mjs';
import { analysisSlot, localClock } from './schedule.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildAnalysisContext } from './analysis-context.mjs';

export const TYPES = ['daily_sleep', 'sleep', 'daily_readiness', 'daily_activity', 'daily_stress', 'daily_spo2', 'workout'];
export function grantedScopes(tokenScope, callbackScope) {
  const parse = value => [...new Set((Array.isArray(value) ? value : [value])
    .filter(v => typeof v === 'string').flatMap(v => v.trim().split(/[\s,]+/)).filter(Boolean))];
  const authoritative = parse(tokenScope);
  return authoritative.length ? authoritative : parse(callbackScope);
}
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function seal(value, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64')).join('.');
}
export function unseal(value, key) {
  const [iv, tag, body] = value.split('.').map(v => Buffer.from(v, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString());
}
export function verifyWebhook(headers, body, secret, now = Date.now()) {
  const timestamp = headers['x-oura-timestamp'], signature = headers['x-oura-signature'];
  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(timestamp).update(body).digest('hex').toUpperCase();
  return typeof signature === 'string' && /^[A-Fa-f0-9]{64}$/.test(signature) && equal(expected, signature.toUpperCase());
}
export class Store {
  constructor(file, key) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.key = key;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (type TEXT, id TEXT, day TEXT, body TEXT, PRIMARY KEY(type,id));
      CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, body TEXT, attempts INTEGER DEFAULT 0, due INTEGER);
      CREATE TABLE IF NOT EXISTS dirty (day TEXT PRIMARY KEY, due INTEGER, first_seen INTEGER);
      CREATE TABLE IF NOT EXISTS sent (day TEXT PRIMARY KEY, digest TEXT, sent_at INTEGER);
    `);
  }
  get(key, fallback = null) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run(key, JSON.stringify(value)); }
  tokens(value) { if (value !== undefined) this.set('tokens', seal(value, this.key)); else { const value = this.get('tokens'); return value ? unseal(value, this.key) : null; } }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  mark(day, now = Date.now()) {
    this.db.prepare(`INSERT INTO dirty VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET due=MIN(excluded.due,dirty.first_seen+300000)`).run(day, now + 90000, now);
  }
  put(type, record, notify = true) {
    if (!record || typeof record.id !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.day)) throw new Error('Invalid Oura record');
    let body = JSON.stringify(record);
    const old = this.db.prepare('SELECT day,body FROM records WHERE type=? AND id=?').get(type, record.id);
    if(type==='apple_workout'&&old){const prior=JSON.parse(old.body);const incoming=record.performance;if(prior.performance&&incoming){const summary={...prior.performance.summary};for(const [k,v] of Object.entries(incoming.summary||{}))if(v!==null)summary[k]=v;record={...record,performance:{...incoming,summary,series:{...prior.performance.series,...incoming.series}}};body=JSON.stringify(record);}}
    if (old?.body === body) return;
    this.db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?,?)').run(type, record.id, record.day, body);
    if (notify) { this.mark(record.day); if (old && old.day !== record.day) this.mark(old.day); }
  }
  remove(type, id) {
    const old = this.db.prepare('SELECT day FROM records WHERE type=? AND id=?').get(type, id);
    this.db.prepare('DELETE FROM records WHERE type=? AND id=?').run(type, id);
    if (old) this.mark(old.day);
  }
  records(day) { return mergeWorkouts(this.db.prepare('SELECT type,body FROM records WHERE day=? ORDER BY type,id').all(day).map(r => ({ type: r.type, ...JSON.parse(r.body) }))); }
  history(day,days=28) { const start=new Date(Date.parse(day+'T12:00:00Z')-days*86400000).toISOString().slice(0,10); return mergeWorkouts(this.db.prepare('SELECT type,body FROM records WHERE day>=? AND day<=? ORDER BY day,type,id').all(start,day).map(r=>({type:r.type,...JSON.parse(r.body)}))); }
  enqueue(event) { this.db.prepare('INSERT OR IGNORE INTO events(key,body,due) VALUES (?,?,?)').run(hash(event), JSON.stringify(event), Date.now()); }
  close() { this.db.close(); }
}

const num = v => typeof v === 'number' && Number.isFinite(v);
const duration = seconds => { const minutes = Math.round(seconds / 60); return `${Math.floor(minutes / 60)}h ${minutes % 60}m`; };
export function summarize(day, records) {
  const find = type => records.find(r => r.type === type);
  const lines = [];
  for (const [type, label] of [['daily_sleep', 'Sleep'], ['daily_readiness', 'Readiness'], ['daily_activity', 'Activity']]) {
    const r = find(type);
    lines.push(`${label}: ${num(r?.score) ? `${r.score}/100` : 'not available'}`);
  }
  const sleeps = records.filter(r => r.type === 'sleep');
  const main = sleeps.filter(r => r.type_of_sleep === 'long_sleep').sort((a,b) => (b.total_sleep_duration ?? 0) - (a.total_sleep_duration ?? 0))[0]
    ?? sleeps.sort((a,b) => (b.total_sleep_duration ?? 0) - (a.total_sleep_duration ?? 0))[0];
  if (main) {
    const parts = [];
    if (num(main.total_sleep_duration)) parts.push(`${duration(main.total_sleep_duration)} asleep`);
    if (num(main.efficiency)) parts.push(`${main.efficiency}% efficiency`);
    if (parts.length) lines.push(`Longest sleep: ${parts.join(' · ')}`);
    const bio = [];
    if (num(main.average_hrv)) bio.push(`HRV ${main.average_hrv} ms`);
    if (num(main.lowest_heart_rate)) bio.push(`lowest HR ${main.lowest_heart_rate} bpm`);
    if (bio.length) lines.push(bio.join(' · '));
  }
  const readiness = find('daily_readiness');
  if (num(readiness?.temperature_deviation)) lines.push(`Temperature vs baseline: ${readiness.temperature_deviation >= 0 ? '+' : ''}${readiness.temperature_deviation.toFixed(2)} °C`);
  const activity = find('daily_activity'), movement = [];
  if (num(activity?.steps)) movement.push(`${activity.steps.toLocaleString('en-US')} steps`);
  if (num(activity?.active_calories)) movement.push(`${activity.active_calories} active kcal`);
  if (movement.length) lines.push(movement.join(' · '));
  const stress = find('daily_stress'), recovery = [];
  if (num(stress?.stress_high)) recovery.push(`${duration(stress.stress_high)} high stress`);
  if (num(stress?.recovery_high)) recovery.push(`${duration(stress.recovery_high)} restorative time`);
  if (recovery.length) lines.push(recovery.join(' · '));
  const spo2 = find('daily_spo2');
  if (num(spo2?.spo2_percentage?.average)) lines.push(`Average SpO2: ${spo2.spo2_percentage.average.toFixed(1)}%`);
  const workouts = records.filter(r => r.type === 'workout');
  if (workouts.length) lines.push(`Workouts: ${workouts.length} (${[...new Set(workouts.map(r => r.activity?.replaceAll('_',' ') ?? 'unclassified'))].join(', ').slice(0,180)})`);
  if (!records.length) return `${day}\nOura no longer has tracked data for this day.`;
  return `${day}\n${lines.join('\n')}\nLatest synced values; the day may be incomplete.`;
}

// Retain only summary inputs, never raw heart-rate traces, location, or location histories.
const fields = {
  daily_sleep: ['score','contributors'], daily_readiness: ['score', 'temperature_deviation'],
  daily_activity: ['score', 'steps', 'active_calories','total_calories'], sleep: ['deep_sleep_duration','rem_sleep_duration','total_sleep_duration','efficiency','average_hrv','lowest_heart_rate'],
  daily_stress: ['stress_high','recovery_high'], daily_spo2: ['spo2_percentage'], workout: ['activity','label','start_datetime','end_datetime','intensity','calories','distance']
};
export function project(type, raw) {
  const result = { id: raw.id, day: raw.day };
  for (const field of fields[type]) if (raw[field] !== undefined) result[field] = raw[field];
  if (type === 'sleep') result.type_of_sleep = raw.type;
  return result;
}

export class RemoteError extends Error {
  constructor(service, status, retryAfter = 0) { super(`${service} request failed (${status}).`); this.status = status; this.retryAfter = retryAfter; }
}
export class Clients {
  constructor(config, store, fetcher = fetch) { this.config = config; this.store = store; this.fetch = fetcher; this.refreshing = null; }
  async request(service, url, options = {}) {
    let response;
    try { response = await this.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw new RemoteError(service, 'network'); }
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const seconds = /^\d+$/.test(retry ?? '') ? Number(retry) : Math.max(0, (Date.parse(retry) - Date.now()) / 1000);
      throw new RemoteError(service, response.status, Number.isFinite(seconds) ? seconds * 1000 : 0);
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new RemoteError(service, 'invalid response'); }
  }
  async exchange(params) {
    const token = await this.request('Oura authorization', 'https://api.ouraring.com/oauth/token', {
      method: 'POST', body: new URLSearchParams({ ...params, client_id: this.config.clientId, client_secret: this.config.clientSecret })
    });
    if (!token.access_token || !token.refresh_token || !num(token.expires_in)) throw new Error('Invalid token response');
    return { ...token, expires_at: Date.now() + token.expires_in * 1000 };
  }
  async refresh() {
    if (!this.refreshing) this.refreshing = (async () => {
      const current = this.store.tokens();
      if (!current) throw new Error('Connect Oura first.');
      const token = await this.exchange({ grant_type: 'refresh_token', refresh_token: current.refresh_token });
      this.store.tokens({ ...current, ...token });
      return token;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async oura(path) {
    let token = this.store.tokens();
    if (!token) throw new Error('Connect Oura first.');
    if (token.expires_at < Date.now() + 60000) token = await this.refresh();
    try { return await this.request('Oura', `https://api.ouraring.com/v2/${path}`, { headers: { Authorization: `Bearer ${token.access_token}` } }); }
    catch(e) {
      if (e.status !== 401) throw e;
      token = await this.refresh();
      return this.request('Oura', `https://api.ouraring.com/v2/${path}`, { headers: { Authorization: `Bearer ${token.access_token}` } });
    }
  }
  async collection(type, start, end) {
    let cursor, records = [], seen = new Set();
    do {
      const params = new URLSearchParams({ start_date: start, end_date: end });
      if (cursor) params.set('next_token', cursor);
      const page = await this.oura(`usercollection/${type}?${params}`);
      if (!Array.isArray(page.data)) throw new Error('Invalid collection response');
      records.push(...page.data.map(r => project(type, r)));
      cursor = page.next_token;
      if (cursor && seen.has(cursor)) throw new Error('Repeated pagination cursor');
      seen.add(cursor);
    } while (cursor);
    return records;
  }
  async verifyAccess(token) {
    const day = new Date().toISOString().slice(0,10);
    const allowed = [];
    for (const type of TYPES) {
      try {
        const page = await this.request('Oura', `https://api.ouraring.com/v2/usercollection/${type}?start_date=${day}&end_date=${day}`, {
          headers: { Authorization: `Bearer ${token.access_token}` }
        });
        if (!Array.isArray(page?.data)) throw new Error('Invalid access-check response');
        allowed.push(type);
      } catch(e) {
        // Permission/membership denials are not network failures and must not be
        // interpreted as missing measurements or allowed access.
        if (e.status !== 403) throw e;
      }
    }
    return allowed;
  }
  async notify(message, title = 'Oura update') {
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.ntfyToken) headers.Authorization = `Bearer ${this.config.ntfyToken}`;
    return this.request('ntfy', `${this.config.ntfyServer}/`, { method: 'POST', headers, body: JSON.stringify({
      topic: this.config.ntfyTopic, title, message, priority: 3
    }) });
  }
  subscription(path = '', method = 'GET', body) {
    return this.request('Oura webhooks', `https://api.ouraring.com/v2/webhook/subscription${path}`, {
      method, headers: { 'x-client-id': this.config.clientId, 'x-client-secret': this.config.clientSecret, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  }
}

export class Worker {
  constructor(config, store, clients, analyzer=null) { this.config = config; this.store = store; this.clients = clients; this.analyzer=analyzer; this.running = false; }
  types() {
    const verified = this.store.get('allowedTypes');
    if (Array.isArray(verified)) return TYPES.filter(t => verified.includes(t));
    const scopes = this.store.get('scopes', ['daily','spo2','workout']);
    return TYPES.filter(t => scopes.includes(t === 'workout' ? 'workout' : t === 'daily_spo2' ? 'spo2' : 'daily'));
  }
  async reconcile() {
    const now = Date.now(), end = new Date(now + 86400000).toISOString().slice(0,10);
    // UTC padding covers local dates on both sides of the date line.
    const start = new Date(now - this.config.lookbackDays * 86400000).toISOString().slice(0,10);
    const initial = !this.store.get('initialized');
    const collections = [];
    for (const type of this.types()) collections.push([type, await this.clients.collection(type, start, end)]);
    this.store.transaction(() => {
      for (const [type, records] of collections) {
        const ids = new Set(records.map(r => r.id));
        for (const old of this.store.db.prepare('SELECT id FROM records WHERE type=? AND day>=? AND day<?').all(type,start,end)) {
          if (!ids.has(old.id)) this.store.remove(type, old.id);
        }
        for (const record of records) this.store.put(type, record, !initial);
      }
      if (initial) {
        const days = this.store.db.prepare('SELECT DISTINCT day FROM records ORDER BY day').all();
        for (const {day} of days.slice(0,-1)) this.store.db.prepare('INSERT OR REPLACE INTO sent VALUES (?,?,?)').run(day, hash(summarize(day,this.store.records(day))), now);
        if (days.length) this.store.mark(days.at(-1).day);
        this.store.set('initialized', true);
      }
      this.store.set('lastSync', now);
    });
  }
  async warmAnalysisHistory() {
    if(!this.analyzer?.enabled() || this.store.get('llm:historyReady')) return;
    const now=Date.now(),start=new Date(now-30*86400000).toISOString().slice(0,10),end=new Date(now+86400000).toISOString().slice(0,10);
    const collections=[];
    for(const type of this.types()) collections.push([type,await this.clients.collection(type,start,end)]);
    this.store.transaction(()=>{
      for(const [type,rows] of collections) for(const row of rows) this.store.put(type,row,false);
      this.store.set('llm:historyReady',true);
      const latest=this.store.db.prepare('SELECT max(day) AS day FROM records').get().day;
      if(latest)this.store.mark(latest);
    });
  }
  async subscriptions() {
    const callback_url = `${this.config.baseUrl}/webhook/oura`;
    const existing = await this.clients.subscription();
    if (!Array.isArray(existing)) throw new Error('Invalid subscriptions response');
    for (const data_type of this.types()) for (const event_type of ['create','update','delete']) {
      const match = existing.find(s => s.callback_url === callback_url && s.data_type === data_type && s.event_type === event_type);
      if (!match) await this.clients.subscription('', 'POST', { callback_url, data_type, event_type, verification_token: this.config.verificationToken });
      else if (Date.parse(match.expiration_time) < Date.now() + 3 * 86400000) await this.clients.subscription(`/renew/${encodeURIComponent(match.id)}`, 'PUT');
    }
    this.store.set('lastSubscriptions', Date.now());
  }
  async events() {
    for (const row of this.store.db.prepare('SELECT * FROM events WHERE due<=? LIMIT 25').all(Date.now())) {
      try {
        const e = JSON.parse(row.body);
        let record;
        if (e.event_type !== 'delete') {
          record = project(e.data_type, await this.clients.oura(`usercollection/${e.data_type}/${encodeURIComponent(e.object_id)}`));
        }
        this.store.transaction(() => {
          if (record) this.store.put(e.data_type, record); else this.store.remove(e.data_type, e.object_id);
          this.store.db.prepare('DELETE FROM events WHERE key=?').run(row.key);
        });
      } catch(e) {
        this.store.db.prepare('UPDATE events SET attempts=attempts+1,due=? WHERE key=?').run(Date.now() + Math.max(e.retryAfter ?? 0, Math.min(3600000, 30000 * 2 ** Math.min(row.attempts,7))), row.key);
        throw e;
      }
    }
  }
  async deliver() {
    if(this.config.scheduledOnly){this.store.db.exec('DELETE FROM dirty');return;}
    for (const {day} of this.store.db.prepare('SELECT day FROM dirty WHERE due<=? ORDER BY day').all(Date.now())) {
      let message = summarize(day, this.store.records(day));
      const digest = hash(message);
      const old = this.store.db.prepare('SELECT digest FROM sent WHERE day=?').get(day);
      if (old?.digest !== digest) {
        await this.clients.notify(this.config.privateNotifications ? `Your Oura data for ${day} has updated. Open Oura to review your latest metrics.` : message);
      }
      this.store.transaction(() => {
        this.store.db.prepare('INSERT OR REPLACE INTO sent VALUES (?,?,?)').run(day, digest, Date.now());
        this.store.db.prepare('DELETE FROM dirty WHERE day=?').run(day);
      });
    }
  }
  async scheduledAnalysis(now=Date.now()) {
    if(!this.analyzer?.enabled() || this.config.privateNotifications) return;
    // Retry notification delivery independently; never repeat a paid request.
    let pending=this.store.get('llm:pending');
    if(pending) {
      await this.clients.notify(pending.message,pending.title);
      this.store.set('llm:pending',null);
    }
    const timezone=this.config.llmTimezone || 'America/Los_Angeles';
    const slot=analysisSlot(now,timezone,this.store.records(localClock(now,timezone).day));
    if(!slot || this.store.get('llm:slot:'+slot.key)) return;
    // Wait for a recent successful Oura sync and initial baseline history.
    if(!this.store.get('llm:historyReady') || now-this.store.get('lastSync',0)>10*60000) return;
    const records=this.store.records(slot.day);
    const context=buildAnalysisContext(slot.day,this.store.history(slot.day,208),this.store.get('cycle'));
    context.check_in={...slot,observed_at:new Date(now).toISOString()};
    // Compare activity only with snapshots from the same local time, never full-day totals.
    const clockParts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now).split(':').map(Number);
    const minute=clockParts[0]*60+clockParts[1];
    const snapshots=this.store.get('activity:snapshots',[]);
    const previous=snapshots.filter(r=>r.day<slot.day&&r.day>=new Date(now-28*86400000).toISOString().slice(0,10)&&r.slot===slot.slot&&r.timezone===timezone&&Math.abs(r.minute-minute)<=30);
    context.activity_comparison={window:'Previous 28 days, same check-in within 30 local minutes',minimum_sample_days:7,metrics:{}};
    for(const metric of ['steps','active_calories']){
      const values=previous.map(r=>r[metric]).filter(v=>typeof v==='number'&&Number.isFinite(v)).sort((a,b)=>a-b);
      const n=values.length,median=n>=7?(values[Math.floor((n-1)/2)]+values[Math.floor(n/2)])/2:null;
      const current=context.metrics[metric];
      context.activity_comparison.metrics[metric]={sample_days:n,median,current_delta_percent:median>0&&typeof current==='number'?Math.round((current-median)/median*100):null};
    }
    this.store.set('activity:snapshots',[...snapshots.filter(r=>r.day>=new Date(now-28*86400000).toISOString().slice(0,10)&&!(r.day===slot.day&&r.slot===slot.slot)),{day:slot.day,slot:slot.slot,timezone,minute,steps:context.metrics.steps,active_calories:context.metrics.active_calories}]);
    // Claim before network I/O: crashes and failures cannot spend this slot twice.
    this.store.set('llm:slot:'+slot.key,{status:'attempted',at:now});
    const result=await this.analyzer.analyze(context);
    this.store.set('llm:slot:'+slot.key,{status:result.status,at:now});
    const {title,message}=checkInNotification(slot.slot,slot.day,records,result.text);
    this.store.set('llm:pending',{title,message,key:slot.key});
    await this.clients.notify(message,title);
    this.store.set('llm:pending',null);
  }
  async tick() {
    if (this.running || !this.store.tokens()) return;
    this.running = true;
    try {
      if (!this.store.get('userId')) {
        const person = await this.clients.oura('usercollection/personal_info');
        if (!person.id) throw new Error('Oura user identifier unavailable');
        this.store.set('userId', person.id);
      }
      this.store.set('error:startup',null);
      for (const [name, interval, task] of [
        ['history',3600000,() => this.warmAnalysisHistory()],
        ['events',10000,() => this.events()],
        ['sync',this.config.pollSeconds * 1000,() => this.reconcile()],
        ['delivery',10000,() => this.deliver()],
        ['analysis',10000,() => this.scheduledAnalysis()],
        ...(this.config.webhooks ? [['subscriptions',12*3600000,() => this.subscriptions()]] : [])
      ]) {
        if (this.store.get(`next:${name}`,0) > Date.now()) continue;
        try {
          await task(); this.store.set(`next:${name}`,Date.now()+interval); this.store.set(`error:${name}`,null); this.store.set(`failures:${name}`,0);
        } catch(e) {
          const failures = this.store.get(`failures:${name}`,0) + 1;
          this.store.set(`failures:${name}`,failures);
          this.store.set(`next:${name}`,Date.now()+Math.max(e.retryAfter ?? 0,Math.min(3600000,30000*2**Math.min(failures-1,7))));
          this.store.set(`error:${name}`,{ message: e instanceof RemoteError ? e.message : 'Operation failed; check configuration and reconnect if needed.', at: Date.now() });
          console.error(`${name}: ${e instanceof RemoteError ? e.message : 'operation failed'}`);
        }
      }
    } finally { this.running = false; }
  }
}
