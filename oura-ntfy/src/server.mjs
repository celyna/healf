import { parseWorkouts } from './apple-health.mjs';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { Store, Clients, Worker, TYPES, equal, verifyWebhook, summarize, grantedScopes } from './core.mjs';
import { Analyzer } from './llm.mjs';

process.umask(0o077);
const env = process.env;
function required(name) { if (!env[name]) throw new Error(`Set ${name} in .env before starting.`); return env[name]; }
function safeURL(value, name) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`${name} must be an origin without a path or credentials.`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','ntfy'].includes(url.hostname))) throw new Error(`${name} requires HTTPS (except loopback or the private ntfy container).`);
  return url.origin;
}
const config = {
  clientId: required('OURA_CLIENT_ID'), clientSecret: required('OURA_CLIENT_SECRET'),
  key: required('ENCRYPTION_KEY'), adminPassword: required('ADMIN_PASSWORD'),
  baseUrl: safeURL(env.BASE_URL || 'http://localhost:3000', 'BASE_URL'),
  ntfyServer: safeURL(env.NTFY_SERVER || 'https://ntfy.sh', 'NTFY_SERVER'),
  ntfyTopic: required('NTFY_TOPIC'), ntfyToken: env.NTFY_TOKEN || '',
  verificationToken: required('WEBHOOK_VERIFICATION_TOKEN'), webhooks: env.WEBHOOKS_ENABLED === 'true',
  pollSeconds: Number(env.POLL_SECONDS || 300), lookbackDays: Number(env.LOOKBACK_DAYS || 7),
  scheduledOnly:true,
  privateNotifications: env.PRIVATE_NOTIFICATIONS === 'true',
  llmEnabled:env.LLM_ENABLED==='true',openaiKey:env.OPENAI_API_KEY||'',openaiModel:env.OPENAI_MODEL||'gpt-5-mini',
  llmMaxDaily:3,llmIntervalSeconds:60,llmTimezone:env.LLM_TIMEZONE||'America/Los_Angeles'
};
new Intl.DateTimeFormat('en-US',{timeZone:config.llmTimezone}).format();
if(!Number.isInteger(config.llmMaxDaily)||config.llmMaxDaily<1||config.llmMaxDaily>100)throw new Error('LLM_MAX_DAILY must be 1–100.');
if(!Number.isInteger(config.llmIntervalSeconds)||config.llmIntervalSeconds<60)throw new Error('LLM_INTERVAL_SECONDS must be at least 60.');
if (!/^[a-f0-9]{64}$/i.test(config.key)) throw new Error('ENCRYPTION_KEY must contain 64 hexadecimal characters.');
if (config.adminPassword.length < 24 || config.verificationToken.length < 24) throw new Error('Use generated secrets of at least 24 characters.');
if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.ntfyTopic)) throw new Error('Invalid ntfy topic.');
if (!Number.isInteger(config.pollSeconds) || config.pollSeconds < 60) throw new Error('POLL_SECONDS must be an integer >= 60.');
if (!Number.isInteger(config.lookbackDays) || config.lookbackDays < 1 || config.lookbackDays > 90) throw new Error('LOOKBACK_DAYS must be between 1 and 90.');
if (config.webhooks && !config.baseUrl.startsWith('https://')) throw new Error('Webhooks require a public HTTPS BASE_URL.');
const store = new Store(env.DATA_FILE || './data/oura.sqlite', config.key);
if(!store.get('apple:token'))store.set('apple:token',randomBytes(32).toString('hex'));
const clients = new Clients(config, store), analyzer = new Analyzer(config,store), worker = new Worker(config, store, clients,analyzer);
const csrf = randomBytes(32).toString('hex');
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sha = text => createHash('sha256').update(text).digest('hex');
const date = ms => ms ? new Date(ms).toISOString().replace('T',' ').slice(0,19) + ' UTC' : 'Not yet';
function respond(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://cloud.ouraring.com; frame-ancestors 'none'; base-uri 'none'", ...headers });
  res.end(body);
}
async function body(req,limit=65536) {
  let length = 0, chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > limit) throw new Error('Request too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function authenticated(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Basic ')) return false;
  return equal(sha(Buffer.from(auth.slice(6), 'base64').toString()), sha(`admin:${config.adminPassword}`));
}
function page(notice = '') {
  const connected = Boolean(store.get('tokens'));
  const latest = store.db.prepare('SELECT MAX(day) AS day FROM records').get().day;
  const errors = ['sync','delivery','events','subscriptions','startup','history','llm','analysis'].map(name => store.get(`error:${name}`)).filter(Boolean);
  const analysis=store.get('llm:cache'),cycle=store.get('cycle');
  const form = (path, label) => `<form method="post" action="${path}"><input type="hidden" name="csrf" value="${csrf}"><button>${label}</button></form>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oura → ntfy</title>
  <style>body{font:16px/1.6 system-ui,sans-serif;background:#f4f3ed;color:#153d34;margin:0}main{max-width:760px;margin:7vh auto;padding:24px}h1{font-size:42px;letter-spacing:-2px;margin:8px 0}h2{font-size:20px}small{letter-spacing:2px}section{background:white;border:1px solid #d3ddd6;border-radius:16px;padding:24px;margin:20px 0}dl{display:grid;grid-template-columns:1fr 1fr;gap:12px}dd{margin:0}pre{white-space:pre-wrap;font:inherit}button{background:#153d34;color:white;border:0;border-radius:8px;padding:12px 18px;font:inherit;cursor:pointer}form{display:inline-block;margin:8px 8px 0 0}.muted{color:#5c706a}.notice{border-left:3px solid #a05c25;padding:12px}a{color:inherit}@media(max-width:480px){dl{display:block}dd{margin-bottom:16px}}</style>
  <main><small>PERSONAL HEALTH SYNC</small><h1>Oura → ntfy</h1><p class="muted">Your latest Oura metrics, delivered to your phone.</p>
  ${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
  <section><h2>${connected ? 'Oura connected' : 'Connect your Oura account'}</h2><dl><dt>Update mode</dt><dd>${config.webhooks ? 'Webhooks + periodic checks' : 'Periodic checks'}</dd><dt>Check interval</dt><dd>${config.pollSeconds / 60} minutes</dd><dt>Last successful sync</dt><dd>${date(store.get('lastSync'))}</dd><dt>Webhook subscriptions checked</dt><dd>${config.webhooks ? date(store.get('lastSubscriptions')) : 'Disabled'}</dd><dt>Pending notifications</dt><dd>${store.db.prepare('SELECT COUNT(*) AS n FROM dirty').get().n}</dd><dt>ntfy destination</dt><dd>${esc(config.ntfyServer)}<br>${esc(config.ntfyTopic)}</dd></dl>
  ${form('/connect',connected ? 'Reconnect Oura' : 'Connect Oura')}${form('/test','Send test notification')}${connected ? form('/sync','Check now') : ''}</section>
  ${errors.map(e => `<p class="notice">${esc(e.message)} ${esc(date(e.at))} — retries continue automatically. For authorization errors, reconnect Oura.</p>`).join('')}
  <section><h2>Latest summary</h2><pre>${esc(latest ? summarize(latest,store.records(latest)) : 'No data yet. Connect Oura, then sync your ring in the Oura app.')}</pre><p class="muted">Summaries describe synced measurements. They do not diagnose conditions or give medical advice. ${config.privateNotifications ? 'Phone notifications hide these metrics.' : 'These metrics appear in your phone notifications.'}</p></section>
  <section><h2>AI recovery &amp; training perspective</h2><p>${analyzer.enabled()?'OpenAI analysis enabled':config.llmEnabled?'Waiting for your OpenAI API key':'AI analysis disabled'} · ${esc(config.openaiModel)}</p><p>At most three AI requests per day in ${esc(config.llmTimezone)}: once when today’s sleep data arrives before 1 p.m., at 1 p.m., and at 10 p.m. Missed windows are skipped; restarting within a window catches up once. Only these scheduled check-ins send automatic notifications; five-minute syncs stay silent. Selected metrics, recent history, personal baseline, and any manually entered cycle context are sent to OpenAI. Raw traces and account identifiers are excluded.</p>
  ${analysis?`<p class="muted">Last generated for ${esc(analysis.day)} at ${date(analysis.createdAt)}. May differ from the latest measurements.</p><pre>${esc(analysis.text)}</pre>`:'<p>No AI analysis yet. Existing metric notifications continue normally.</p>'}</section>
  <section><h2>Apple Health workouts</h2><p>Last upload: ${date(store.get('apple:lastImport')?.at)} · ${store.get('apple:lastImport')?.count??0} workouts in last upload.</p><p>Upload header: Authorization</p><pre>Bearer ${esc(store.get('apple:token'))}</pre><p>Keep this upload credential private. Imported workouts join the scheduled summaries; uploads do not send notifications. Repeated IDs update existing workouts. Deletions in Apple Health are not propagated automatically.</p></section>
  <section><h2>Cycle context from your Oura app (optional)</h2><p>Oura does not provide Cycle Insights through the API integrated here. You can copy the current cycle day and phase from Oura. This observation is used only for that date; phases are not predicted or treated as training clearance.</p>
  <form method="post" action="/cycle"><input type="hidden" name="csrf" value="${csrf}">
  <p><label>Date shown in Oura <input type="date" name="observedDay" required value="${esc(cycle?.observedDay||'')}"></label></p>
  <p><label>Cycle day <input type="number" min="1" max="120" name="cycleDay" required value="${esc(cycle?.cycleDay||'')}"></label></p>
  <p><label>Phase shown in Oura <select name="phase">${['unknown','follicular','luteal','menstrual','ovulatory'].map(p=>`<option value="${p}" ${cycle?.phase===p?'selected':''}>${p}</option>`).join('')}</select></label></p>
  <p class="muted">Saving includes this reproductive-health context in future OpenAI analysis for the selected date. Leave blank if you prefer not to share it.</p><button>Save cycle context</button></form>
  ${cycle?form('/cycle/clear','Remove cycle context'):''}</section>
  <p class="muted">Refresh this page to see updates. Nearby changes are grouped for 90 seconds. Missing values stay marked as unavailable.</p></main></html>`;
}

const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, config.baseUrl), path = url.pathname;
    if(path==='/import/apple-health'){
      if(req.method!=='POST')return respond(res,405,'POST required');
      if(!equal(sha(req.headers.authorization||''),sha('Bearer '+store.get('apple:token'))))return respond(res,401,'Unauthorized');
      if(!(req.headers['content-type']||'').startsWith('application/json'))return respond(res,415,'JSON required');
      let rows;try{rows=parseWorkouts(JSON.parse((await body(req,10485760)).toString()),config.llmTimezone);}catch{return respond(res,400,'Invalid workout upload. Use JSON version 2, workouts only, no routes, minute-grouped metrics, under 10 MB.');}
      store.transaction(()=>{for(const row of rows)store.put('apple_workout',row,false);store.set('apple:lastImport',{at:Date.now(),count:rows.length});});
      return respond(res,200,JSON.stringify({accepted:rows.length}),{'Content-Type':'application/json'});
    }
    if (path === '/healthz' && req.method === 'GET') return respond(res,200,'ok');
    if (path === '/webhook/oura') {
      if (!config.webhooks) return respond(res,404,'Webhooks disabled');
      if (req.method === 'GET') {
        if (!equal(url.searchParams.get('verification_token'),config.verificationToken) || !url.searchParams.get('challenge')) return respond(res,401,'Invalid verification');
        return respond(res,200,JSON.stringify({challenge:url.searchParams.get('challenge')}),{'Content-Type':'application/json'});
      }
      if (req.method !== 'POST') return respond(res,405,'Method not allowed');
      const raw = await body(req);
      if (!verifyWebhook(req.headers,raw,config.clientSecret)) return respond(res,401,'Invalid signature or timestamp');
      let event; try { event = JSON.parse(raw); } catch { return respond(res,400,'Invalid JSON'); }
      if (!TYPES.includes(event.data_type) || !['create','update','delete'].includes(event.event_type) || typeof event.object_id !== 'string' || event.object_id.length > 200) return respond(res,400,'Invalid event');
      if (!store.get('userId')) return respond(res,503,'Account not ready');
      if (String(event.user_id) !== String(store.get('userId'))) return respond(res,204,'');
      if (!worker.types().includes(event.data_type)) return respond(res,204,'');
      store.enqueue(event); // Durable before acknowledging to Oura.
      return respond(res,200,'Accepted');
    }
    if (path === '/oauth/callback' && req.method === 'GET') {
      const pending = store.get('oauthState');
      const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('oura_state='))?.slice(11);
      if (!pending || Date.now() > pending.expires || !equal(pending.state,url.searchParams.get('state')) || !equal(pending.state,cookie)) return respond(res,400,'Authorization expired or invalid. Return to the status page and connect again.');
      store.set('oauthState',null);
      if (url.searchParams.has('error')) return respond(res,400,'Oura authorization was declined. Return to the status page to try again.');
      const code = url.searchParams.get('code');
      if (!code) return respond(res,400,'Missing authorization code');
      if (worker.running) return respond(res,409,'A sync is active. Wait a moment, then start Connect Oura again.');
      worker.running = true;
      try {
        const token = await clients.exchange({ grant_type:'authorization_code',code,redirect_uri:`${config.baseUrl}/oauth/callback` });
        const person = await clients.request('Oura','https://api.ouraring.com/v2/usercollection/personal_info',{headers:{Authorization:`Bearer ${token.access_token}`}});
        if (!person.id) throw new Error('Missing user id');
        if (store.get('userId') && store.get('userId') !== person.id) return respond(res,409,'This service is linked to another Oura account. Use a separate data volume for a different person.');
        const scopes = grantedScopes(token.scope, url.searchParams.getAll('scope'));
        const allowedTypes = await clients.verifyAccess(token);
        if (!allowedTypes.some(t => ['daily_sleep','daily_readiness','daily_activity'].includes(t))) return respond(res,403,'Oura denied access to all daily-data endpoints. Check daily-data consent and your Oura membership, then reconnect.');
        store.transaction(() => {
          store.tokens(token); store.set('userId',person.id); store.set('scopes',scopes); store.set('allowedTypes',allowedTypes);
          for (const name of ['sync','subscriptions','events','delivery']) store.set(`next:${name}`,0);
        });
      } finally { worker.running = false; }
      return respond(res,303,'Connected',{'Location':'/','Set-Cookie':'oura_state=; HttpOnly; SameSite=Lax; Path=/oauth/callback; Max-Age=0'});
    }
    if (!authenticated(req)) return respond(res,401,'Sign in as admin with ADMIN_PASSWORD from your .env file.',{'WWW-Authenticate':'Basic realm="Oura ntfy", charset="UTF-8"'});
    if (path === '/' && req.method === 'GET') return respond(res,200,page(),{'Content-Type':'text/html; charset=utf-8'});
    if (req.method !== 'POST') return respond(res,404,'Not found');
    const form = new URLSearchParams((await body(req)).toString());
    if (!equal(form.get('csrf'),csrf)) return respond(res,403,'This form has expired. Reopen the status page and try again.');
    // Privacy policies can serialize a legitimate form origin as "null".
    // A matching unpredictable form token remains mandatory for every POST.
    if (req.headers.origin && req.headers.origin !== 'null' && req.headers.origin !== config.baseUrl) return respond(res,403,`Open the status page at ${config.baseUrl} and try again. The address used for this form does not match the configured address.`);
    if(path==='/cycle') {
      const observedDay=form.get('observedDay'),cycleDay=Number(form.get('cycleDay')),phase=form.get('phase');
      const parsed=Date.parse(observedDay+'T12:00:00Z');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(observedDay||'')||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==observedDay||parsed>Date.now()+86400000||!Number.isInteger(cycleDay)||cycleDay<1||cycleDay>120||!['unknown','follicular','luteal','menstrual','ovulatory'].includes(phase))return respond(res,400,'Enter a valid observation date, cycle day, and phase copied from Oura.');
      store.set('cycle',{observedDay,cycleDay,phase});store.mark(observedDay);
      return respond(res,303,'Saved',{Location:'/'});
    }
    if(path==='/cycle/clear') {
      store.set('cycle',null);store.set('llm:cache',null);
      return respond(res,303,'Removed',{Location:'/'});
    }
    if (path === '/connect') {
      const state = randomBytes(32).toString('hex');
      store.set('oauthState',{state,expires:Date.now()+600000});
      const query = new URLSearchParams({client_id:config.clientId,redirect_uri:`${config.baseUrl}/oauth/callback`,response_type:'code',scope:'daily spo2 workout',state});
      const authorizeUrl = `https://cloud.ouraring.com/oauth/authorize?${query}`;
      // End the form navigation before Oura's cross-origin identity-provider redirects.
      // A normal top-level navigation is not constrained by CSP form-action.
      return respond(res,200,`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${esc(authorizeUrl)}"><title>Connect Oura</title><main><h1>Continue to Oura</h1><p>Opening Oura's secure sign-in page.</p><p><a href="${esc(authorizeUrl)}">Continue to Oura sign-in</a></p></main></html>`, {'Content-Type':'text/html; charset=utf-8','Set-Cookie':`oura_state=${state}; HttpOnly; SameSite=Lax; Path=/oauth/callback; Max-Age=600${config.baseUrl.startsWith('https:') ? '; Secure' : ''}`});
    }
    if (path === '/test') {
      await clients.notify('Your Oura → ntfy connection works. Health summaries will arrive here after you connect Oura and sync your ring.','Oura connection test');
      return respond(res,200,page('Test notification accepted by ntfy. Check your phone.'),{'Content-Type':'text/html; charset=utf-8'});
    }
    if (path === '/sync') { store.set('next:sync',0); return respond(res,303,'Sync queued',{Location:'/'}); }
    return respond(res,404,'Not found');
  } catch(e) {
    console.error('HTTP operation failed'); // Never log request URLs, tokens, or health payloads.
    respond(res,502,'Operation failed. Check your configuration and service connectivity, then try again.');
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
const timer = setInterval(() => worker.tick().catch(() => {
  store.set('error:startup',{message:'Unable to initialize Oura access. Reconnect Oura.',at:Date.now()});
}),10000);
server.listen(Number(env.PORT || 3000),env.HOST || '0.0.0.0',() => console.log('Oura ntfy service ready on port ' + server.address().port));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true; clearInterval(timer); server.close();
  const deadline = Date.now()+25000;
  while (worker.running && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
  if (!worker.running) store.close();
  process.exit(0);
}
process.on('SIGTERM',stop); process.on('SIGINT',stop);
