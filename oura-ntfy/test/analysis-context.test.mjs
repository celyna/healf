import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAnalysisContext} from '../src/analysis-context.mjs';
test('baseline excludes today and future data and requires seven measured days',()=>{
  const records=Array.from({length:7},(_,i)=>({type:'daily_readiness',day:`2026-09-${20+i}`,score:80}));
  records.push({type:'daily_readiness',day:'2026-09-27',score:60},{type:'daily_readiness',day:'2026-09-28',score:100});
  const c=buildAnalysisContext('2026-09-27',records);
  assert.equal(c.baseline.metrics.readiness_score.median,80);
  assert.equal(c.baseline.metrics.readiness_score.current_delta,-20);
  assert.equal(c.baseline.metrics.hrv_ms.median,null);
  assert.equal(buildAnalysisContext('2026-09-27',records.slice(1)).baseline.metrics.readiness_score.median,null);
});
test('workout context counts only three calendar days and strips identifiers but includes requested workout labels',()=>{
  const records=[24,25,26,27,28].map(n=>({type:'workout',day:`2026-09-${n}`,id:'private-id',label:'private-label',activity:'running',start_datetime:`2026-09-${n}T10:00:00Z`,end_datetime:`2026-09-${n}T10:45:00Z`,intensity:'moderate'}));
  const c=buildAnalysisContext('2026-09-27',records);
  assert.equal(c.workouts.count,3);
  assert.equal(c.workouts.items[0].duration_minutes,45);
  assert.ok(!JSON.stringify(c).includes('private-id'));
  assert.equal(c.workouts.items[0].label,'private-label');
});
test('cycle observations do not predict a phase or future cycle day',()=>{
  const cycle={observedDay:'2026-09-27',cycleDay:12,phase:'follicular'};
  assert.equal(buildAnalysisContext('2026-09-27',[],cycle).cycle.cycle_day,12);
  const later=buildAnalysisContext('2026-09-28',[],cycle).cycle;
  assert.equal(later.phase,null);assert.equal(later.cycle_day,null);
  assert.equal(buildAnalysisContext('2026-10-10',[],cycle).cycle.available,false);
});
test('historical runs include performance and next-day recovery without raw samples',()=>{
 const records=[{type:'workout',day:'2026-09-01',activity:'running',duration_seconds:1800,distance:5000,performance:{summary:{average_hr_bpm:150},series:{heartRateData:[{at:'2026-09-01T10:00:00Z',value:150}]}}},{type:'daily_readiness',day:'2026-09-01',score:80},{type:'daily_readiness',day:'2026-09-02',score:70}];
 const c=buildAnalysisContext('2026-10-04',records);assert.equal(c.historical_workouts[0].before.readiness_score,80);assert.equal(c.historical_workouts[0].next_day.readiness_score,70);assert.equal(c.historical_workouts[0].performance.average_hr_bpm,150);assert.ok(!JSON.stringify(c).includes('2026-09-01T10:00:00Z'));
});
test('historical comparisons include strength, cycling and yoga with activity identity',()=>{
 const records=['strength_training','cycling','yoga'].map(activity=>({type:'workout',day:'2026-09-25',activity,start_datetime:'2026-09-25T10:00:00Z',end_datetime:'2026-09-25T11:00:00Z'}));
 const c=buildAnalysisContext('2026-09-27',records);assert.equal(c.historical_workouts.length,3);assert.deepEqual(c.historical_workouts.map(w=>w.activity),['strength_training','cycling','yoga']);
});
