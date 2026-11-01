import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoveryHistory} from '../src/recovery-history.mjs';
const facts=rows=>rows.find(r=>r.type==='facts')||{};
const day=n=>new Date(Date.UTC(2026,7,1+n)).toISOString().slice(0,10);
const workout=(d,activity,minutes,distance)=>({day:d,type:'workout',activity,duration_seconds:minutes*60,distance});
test('matches combined activity and distance; preserves outcomes and excludes future',()=>{
 const records=Array.from({length:65},(_,i)=>({type:'facts',day:day(i),readiness_score:80,hrv_ms:60,sleep_score:85}));
 for(const n of [35,45,60])records.push(workout(day(n),'outdoor run',90,n===45?3000:16093),workout(day(n),'pilates',45));
 records.find(r=>r.day===day(36)).readiness_score=55;
 const r=recoveryHistory(day(60),records,facts);
 assert.equal(r.workout_matches.today.matches.length,1);
 assert.equal(r.workout_matches.today.matches[0].anchor.day,day(35));
 assert.equal(r.workout_matches.today.matches[0].following_days[0].metrics.readiness_score,55);
 assert.equal(r.workout_matches.today.matches[0].following_days.length,3);
 assert.equal(r.current.baseline.readiness_score.sample_days,28);
 for(const m of r.recovery_state_matches.matches)assert.ok(m.following_days.every(x=>x.day<day(60)));
});
test('sparse history cannot imply comparable recovery; absent workouts do not match',()=>{
 const r=recoveryHistory(day(10),[{type:'facts',day:day(10),readiness_score:40}],facts);
 assert.equal(r.current.baseline.readiness_score.median,null);
 assert.equal(r.recovery_state_matches.matches.length,0);
 assert.equal(r.workout_matches.today.matches.length,0);
});
