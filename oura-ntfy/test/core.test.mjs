import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, Clients, Worker, RemoteError, equal, seal, unseal, verifyWebhook, project, summarize, grantedScopes } from '../src/core.mjs';

test('granted permissions accept delimiter variants without inventing consent',()=>{
  assert.deepEqual(grantedScopes('daily,spo2,workout',''),['daily','spo2','workout']);
  assert.deepEqual(grantedScopes(undefined,['daily\tworkout,spo2']),['daily','workout','spo2']);
  assert.deepEqual(grantedScopes(['daily','workout'],''),['daily','workout']);
  assert.deepEqual(grantedScopes('workout','daily workout'),['workout']);
  assert.deepEqual(grantedScopes(undefined,''),[]);
});

const key = 'ab'.repeat(32);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'oura-test-'));
  const store = new Store(join(dir,'data.sqlite'),key);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return store;
}
const config = { clientId:'id',clientSecret:'secret',ntfyServer:'https://ntfy.sh',ntfyTopic:'test',ntfyToken:'tk',baseUrl:'https://example.com',verificationToken:'verify',lookbackDays:7,pollSeconds:300,webhooks:false };
const response = data => new Response(JSON.stringify(data),{status:200});

test('missing scope metadata is resolved by actual API permissions, including empty data',async t=>{
  const store=fixture(t);
  const clients=new Clients(config,store,async url=>url.includes('/daily_stress?') || url.includes('/daily_spo2?') ? new Response('',{status:403}) : response({data:[]}));
  const allowed=await clients.verifyAccess({access_token:'test'});
  assert.ok(allowed.includes('daily_sleep'));
  assert.ok(!allowed.includes('daily_stress'));
  assert.ok(!allowed.includes('daily_spo2'));
  store.set('allowedTypes',allowed);
  store.set('scopes',[]);
  assert.deepEqual(new Worker(config,store,clients).types(),allowed);
});
test('permission probes reject transient failures and never invent authorization',async t=>{
  const store=fixture(t);
  const denied=new Clients(config,store,async()=>new Response('',{status:403}));
  assert.deepEqual(await denied.verifyAccess({access_token:'test'}),[]);
  const failing=new Clients(config,store,async()=>new Response('',{status:503}));
  await assert.rejects(()=>failing.verifyAccess({access_token:'test'}),e=>e.status===503);
});

test('token encryption round trips, rejects wrong keys, and does not store plaintext',t=>{
  const store = fixture(t), token = {access_token:'secret-access',refresh_token:'secret-refresh'};
  store.tokens(token);
  assert.deepEqual(store.tokens(),token);
  assert.ok(!store.get('tokens').includes('secret-access'));
  assert.throws(()=>unseal(seal(token,key),'cd'.repeat(32)));
  assert.equal(equal('a','é'),false);
});
test('webhook signature authenticates exact bytes and rejects tampering, stale or malformed timestamps',()=>{
  const now = Date.now(), timestamp = String(Math.floor(now/1000)), raw = Buffer.from('{ "a": 1 }');
  const signature = createHmac('sha256','secret').update(timestamp).update(raw).digest('hex').toUpperCase();
  const headers = {'x-oura-timestamp':timestamp,'x-oura-signature':signature};
  assert.equal(verifyWebhook(headers,raw,'secret',now),true);
  assert.equal(verifyWebhook(headers,Buffer.from('{"a":1}'),'secret',now),false);
  assert.equal(verifyWebhook(headers,raw,'secret',now+301000),false);
  assert.equal(verifyWebhook({...headers,'x-oura-timestamp':'abc'},raw,'secret',now),false);
  assert.equal(verifyWebhook({...headers,'x-oura-signature':'not a signature'},raw,'secret',now),false);
});
test('summaries preserve zeros, label missing values, round durations, and avoid raw traces',()=>{
  const sleep = project('sleep',{id:'s',day:'2026-09-26',type:'long_sleep',total_sleep_duration:28799,average_hrv:0,heart_rate:{items:[60]},label:'private'});
  assert.equal(sleep.heart_rate,undefined);
  assert.equal(sleep.label,undefined);
  const summary = summarize('2026-09-26',[{type:'sleep',...sleep},{type:'daily_activity',score:0,steps:0,active_calories:0}]);
  assert.match(summary,/8h 0m asleep/);
  assert.match(summary,/HRV 0 ms/);
  assert.match(summary,/Activity: 0\/100/);
  assert.match(summary,/0 steps/);
  assert.match(summary,/Sleep: not available/);
  assert.doesNotMatch(summary,/undefined|NaN/);
});
test('pagination carries the next_token and preserves all records',async t=>{
  const store = fixture(t); store.tokens({access_token:'a',expires_at:Date.now()+3600000});
  const requests = [];
  const clients = new Clients(config,store,async url=>{
    requests.push(url);
    return response(requests.length===1 ? {data:[{id:'1',day:'2026-09-26',score:80}],next_token:'page 2'} : {data:[{id:'2',day:'2026-09-27',score:81}],next_token:null});
  });
  const result = await clients.collection('daily_sleep','2026-09-26','2026-09-28');
  assert.equal(result.length,2);
  assert.match(requests[1],/next_token=page\+2/);
});
test('concurrent refreshes use a rotating refresh token once and persist its replacement',async t=>{
  const store = fixture(t); store.tokens({access_token:'a',refresh_token:'r',expires_at:0});
  let calls=0;
  const clients = new Clients(config,store,async (url,options)=>{
    calls++; assert.equal(options.body.get('refresh_token'),'r');
    await new Promise(r=>setTimeout(r,10));
    return response({access_token:'new-a',refresh_token:'new-r',expires_in:3600});
  });
  await Promise.all([clients.refresh(),clients.refresh()]);
  assert.equal(calls,1); assert.equal(store.tokens().refresh_token,'new-r');
});
test('expired/revoked access token refreshes once on 401',async t=>{
  const store = fixture(t); store.tokens({access_token:'old',refresh_token:'r',expires_at:Date.now()+3600000});
  const calls=[];
  const clients = new Clients(config,store,async (url,options)=>{
    calls.push(url);
    if(url.endsWith('/oauth/token')) return response({access_token:'new',refresh_token:'new-r',expires_in:3600});
    if(options.headers.Authorization==='Bearer old') return new Response('',{status:401});
    return response({id:'user'});
  });
  assert.equal((await clients.oura('usercollection/personal_info')).id,'user');
  assert.equal(calls.length,3);
});
test('rate-limit Retry-After is exposed to scheduler without leaking response content',async t=>{
  const clients = new Clients(config,fixture(t),async()=>new Response('sensitive upstream details',{status:429,headers:{'retry-after':'123'}}));
  await assert.rejects(()=>clients.notify('test'),e=>e.retryAfter===123000 && !e.message.includes('sensitive'));
});
test('initial import sends only the most recent day, unchanged data stays quiet, later changes notify',async t=>{
  const store=fixture(t); store.set('scopes',['daily']);
  const a=new Date(Date.now()-86400000).toISOString().slice(0,10), b=new Date().toISOString().slice(0,10);
  let score=80, sent=[];
  const clients={ collection:async type=>type==='daily_sleep'?[{id:'a',day:a,score:70},{id:'b',day:b,score}]:[],notify:async message=>sent.push(message) };
  const worker=new Worker(config,store,clients);
  await worker.reconcile();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM dirty').get().n,1);
  store.db.exec('UPDATE dirty SET due=0'); await worker.deliver();
  assert.equal(sent.length,1); assert.match(sent[0],/80\/100/);
  await worker.reconcile(); await worker.deliver(); assert.equal(sent.length,1);
  score=85; await worker.reconcile(); store.db.exec('UPDATE dirty SET due=0'); await worker.deliver();
  assert.equal(sent.length,2); assert.match(sent[1],/85\/100/);
});
test('failed notifications remain queued and are marked sent only after success',async t=>{
  const store=fixture(t); store.put('daily_sleep',{id:'s',day:'2026-09-27',score:88});store.db.exec('UPDATE dirty SET due=0');
  let fail=true,calls=0;
  const worker=new Worker(config,store,{notify:async()=>{calls++;if(fail)throw new RemoteError('ntfy',503);}});
  await assert.rejects(()=>worker.deliver());
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM dirty').get().n,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sent').get().n,0);
  fail=false;await worker.deliver();await worker.deliver();
  assert.equal(calls,2);
});
test('event queue is persistent, deduplicates delivery, updates and deletes records',async t=>{
  const store=fixture(t), event={event_type:'update',data_type:'daily_sleep',object_id:'s',user_id:'u'};
  store.enqueue(event);store.enqueue(event);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n,1);
  const worker=new Worker(config,store,{oura:async()=>({id:'s',day:'2026-09-27',score:88})});
  await worker.events();assert.equal(store.records('2026-09-27').length,1);
  store.enqueue({...event,event_type:'delete'});await worker.events();
  assert.equal(store.records('2026-09-27').length,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM dirty').get().n,1);
});
test('temporary object 404 is retried instead of silently losing the update',async t=>{
  const store=fixture(t);store.enqueue({event_type:'create',data_type:'sleep',object_id:'s'});
  const worker=new Worker(config,store,{oura:async()=>{throw new RemoteError('Oura',404);}});
  await assert.rejects(()=>worker.events());
  assert.equal(store.db.prepare('SELECT attempts FROM events').get().attempts,1);
});
test('subscription setup is idempotent and renews expiring subscriptions',async t=>{
  const store=fixture(t);store.set('scopes',['spo2']);const writes=[];
  const subscriptions=['create','update'].map(event_type=>({id:event_type,callback_url:config.baseUrl+'/webhook/oura',data_type:'daily_spo2',event_type,expiration_time:new Date(Date.now()+(event_type==='create'?86400000:10*86400000)).toISOString()}));
  const worker=new Worker(config,store,{subscription:async(path='',method='GET',body)=>{if(method==='GET')return subscriptions;writes.push({path,method,body});}});
  await worker.subscriptions();
  assert.deepEqual(writes.map(w=>w.method),['PUT','POST']);
  assert.equal(writes[0].path,'/renew/create');assert.equal(writes[1].body.event_type,'delete');
});
test('partial reconciliation failures do not replace cached data',async t=>{
  const store=fixture(t);store.set('scopes',['daily']);store.put('daily_sleep',{id:'s',day:'2026-09-27',score:88},false);
  const worker=new Worker(config,store,{collection:async type=>{if(type==='sleep')throw new RemoteError('Oura',503);return [];}});
  await assert.rejects(()=>worker.reconcile());assert.equal(store.records('2026-09-27').length,1);
});
test('debounce waits for nearby updates but cannot postpone delivery forever',t=>{
  const store=fixture(t);store.mark('2026-09-27',1000);store.mark('2026-09-27',250000);
  const row=store.db.prepare('SELECT * FROM dirty').get();assert.equal(row.due,301000);
});
test('private notification mode withholds health metrics',async t=>{
  const store=fixture(t);store.put('daily_sleep',{id:'s',day:'2026-09-27',score:88});store.db.exec('UPDATE dirty SET due=0');let text;
  const worker=new Worker({...config,privateNotifications:true},store,{notify:async message=>{text=message;}});
  await worker.deliver();assert.doesNotMatch(text,/88|Sleep:/);assert.match(text,/has updated/);
});
test('changed metrics notify without requesting AI',async t=>{
 const store=fixture(t);store.put('daily_sleep',{id:'s',day:'2026-09-27',score:88});store.db.exec('UPDATE dirty SET due=0');
 let calls=0;const messages=[];
 const worker=new Worker(config,store,{notify:async m=>messages.push(m)},{enabled:()=>true,analyze:async()=>{calls++;}});
 await worker.deliver();assert.match(messages[0],/Sleep: 88/);assert.doesNotMatch(messages[0],/AI perspective/);assert.equal(calls,0);
});
test('analysis history backfill does not enqueue a month of notifications',async t=>{
  const store=fixture(t);store.set('allowedTypes',['daily_sleep']);
  const worker=new Worker(config,store,{collection:async()=>[{id:'old',day:'2026-09-01',score:70},{id:'latest',day:'2026-09-27',score:80}]},{enabled:()=>true});
  await worker.warmAnalysisHistory();
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM dirty').get().n,1);
  assert.equal(store.db.prepare('SELECT day FROM dirty').get().day,'2026-09-27');
  assert.equal(store.get('llm:historyReady'),true);
});
test('scheduled-only mode silently clears changed metrics without sending or calling AI',async t=>{
 const store=fixture(t);store.put('daily_sleep',{id:'s',day:'2026-09-27',score:88});store.db.exec('UPDATE dirty SET due=0');
 let sent=0;const worker=new Worker({...config,scheduledOnly:true},store,{notify:async()=>sent++},{enabled:()=>true,analyze:async()=>assert.fail('no AI on changes')});
 await worker.deliver();assert.equal(sent,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM dirty').get().n,0);
});
