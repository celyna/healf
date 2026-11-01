import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisSlot,localClock} from '../src/schedule.mjs';
import {Store,Worker} from '../src/core.mjs';
const zone='America/Los_Angeles';
test('Pacific scheduling follows DST and local dates, with no morning without today sleep',()=>{
 assert.equal(analysisSlot(Date.parse('2026-09-27T19:59:00Z'),zone,[]),null);
 assert.equal(analysisSlot(Date.parse('2026-09-27T20:00:00Z'),zone,[]).slot,'afternoon');
 assert.equal(analysisSlot(Date.parse('2026-09-28T05:00:00Z'),zone,[]).key,'2026-09-27:bedtime');
 assert.equal(analysisSlot(Date.parse('2026-12-27T21:00:00Z'),zone,[]).slot,'afternoon');
 assert.deepEqual(localClock(Date.parse('2026-11-01T09:30:00Z'),zone),{day:'2026-11-01',hour:1});
 assert.equal(analysisSlot(Date.parse('2026-09-27T15:00:00Z'),zone,[{type:'daily_sleep',day:'2026-09-27',score:80}]).slot,'morning');
});
test('three slots, repeat checks and worker restarts do not repeat requests; notification retries reuse output',async(t)=>{
 const store=new Store(':memory:','ab'.repeat(32));t.after(()=>store.close());
 store.set('llm:historyReady',true);store.put('daily_sleep',{id:'s',day:'2026-09-27',score:80},false);
 let calls=0,sends=0,fail=false;
 const analyzer={enabled:()=>true,analyze:async()=>{calls++;return {status:'generated',text:'Example'};}};
 const clients={notify:async()=>{sends++;if(fail)throw Error('offline');}};
 const worker=()=>new Worker({llmTimezone:zone},store,clients,analyzer);
 const run=async time=>{const now=Date.parse(time);store.set('lastSync',now);await worker().scheduledAnalysis(now);};
 await run('2026-09-27T15:00:00Z');await run('2026-09-27T16:00:00Z');assert.equal(calls,1);
 fail=true;await assert.rejects(run('2026-09-27T20:00:00Z'));assert.equal(calls,2);
 fail=false;await run('2026-09-27T20:01:00Z');assert.equal(calls,2);assert.equal(store.get('llm:pending'),null);
 await run('2026-09-28T05:00:00Z');await run('2026-09-28T06:00:00Z');assert.equal(calls,3);assert.equal(sends,4);
});
test('failed analysis consumes its slot, stale sync waits, and late restart skips missed windows',async(t)=>{
 const store=new Store(':memory:','ab'.repeat(32));t.after(()=>store.close());store.set('llm:historyReady',true);
 let calls=0;const w=new Worker({llmTimezone:zone},store,{notify:async()=>{}},{enabled:()=>true,analyze:async()=>{calls++;return{status:'failed',text:''};}});
 const now=Date.parse('2026-09-28T05:00:00Z');await w.scheduledAnalysis(now);assert.equal(calls,0);
 store.set('lastSync',now);await w.scheduledAnalysis(now);await w.scheduledAnalysis(now);assert.equal(calls,1);
 assert.equal(store.get('llm:slot:2026-09-27:morning'),null);assert.equal(store.get('llm:slot:2026-09-27:afternoon'),null);
});
test('activity comparison uses prior same-time snapshots and requires seven days',async(t)=>{
 const store=new Store(':memory:','ab'.repeat(32));t.after(()=>store.close());const now=Date.parse('2026-09-27T20:00:00Z');
 store.set('llm:historyReady',true);store.set('lastSync',now);store.put('daily_activity',{id:'a',day:'2026-09-27',steps:2000,active_calories:100},false);
 const samples=Array.from({length:7},(_,i)=>({day:`2026-09-${20+i}`,slot:'afternoon',timezone:zone,minute:780,steps:1000,active_calories:50}));
 samples.push({day:'2026-09-19',slot:'afternoon',timezone:zone,minute:900,steps:99999});store.set('activity:snapshots',samples);
 const w=new Worker({llmTimezone:zone},store,{notify:async()=>{}},{enabled:()=>true,analyze:async c=>{assert.equal(c.activity_comparison.metrics.steps.sample_days,7);assert.equal(c.activity_comparison.metrics.steps.median,1000);assert.equal(c.activity_comparison.metrics.steps.current_delta_percent,100);return{text:'ok',status:'generated'};}});
 await w.scheduledAnalysis(now);assert.equal(store.get('activity:snapshots').filter(r=>r.day==='2026-09-27').length,1);
});
