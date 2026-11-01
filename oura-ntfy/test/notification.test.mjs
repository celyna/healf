import test from 'node:test';
import assert from 'node:assert/strict';
import {checkInNotification,hhmm} from '../src/notification.mjs';
test('morning uses main sleep, preserves zeros, and shows missing values',()=>{
 const n=checkInNotification('morning','2026-09-27',[
 {type:'daily_sleep',score:0},{type:'sleep',type_of_sleep:'nap',average_hrv:99,total_sleep_duration:100},
 {type:'sleep',type_of_sleep:'long_sleep',average_hrv:40,lowest_heart_rate:50,total_sleep_duration:20000},
 {type:'daily_spo2',spo2_percentage:{average:98.2}}],'GJ :)');
 assert.equal(n.title,'☀️ gm! it’s 09/27 ☀️');assert.match(n.message,/sleep: 0\/100/);
 assert.match(n.message,/avg hrv: 40 ms/);assert.match(n.message,/readiness: not synced yet/);
 assert.match(n.message,/spo2: 98.2%/);assert.ok(n.message.endsWith('gj :)'));
});
test('afternoon and bedtime use HH:MM and never invent goals',()=>{
 const records=[{type:'daily_activity',steps:1234,active_calories:0},{type:'daily_stress',stress_high:3660,recovery_high:0}];
 for(const slot of ['afternoon','bedtime']){
 const n=checkInNotification(slot,'2026-09-27',records,'nice work 🫶');
 assert.match(n.message,/steps: 1,234/);assert.match(n.message,/active cals: 0 kcal/);
 assert.match(n.message,/01:01 high stress/);assert.match(n.message,/00:00 restorative/);
 assert.doesNotMatch(n.message,/goal|out of|sleep debt/);
 }
 assert.equal(hhmm(null),'not synced yet');assert.equal(hhmm(0),'00:00');
});
test('expanded morning stages use Oura contributor thumbs; workouts and calories stay in later slots',()=>{
 const records=[{type:'daily_sleep',score:90,contributors:{deep_sleep:70}},{type:'sleep',type_of_sleep:'long_sleep',deep_sleep_duration:5400,rem_sleep_duration:6000,total_sleep_duration:28000,efficiency:92},{type:'daily_activity',total_calories:1800},{type:'workout',day:'2026-09-27',activity:'walking',label:'Morning Walk'},{type:'workout',day:'2026-09-26',activity:'running'}];
 const morning=checkInNotification('morning','2026-09-27',records,'note');assert.match(morning.message,/deep sleep: 1h 30m 👍🏻/);assert.match(morning.message,/efficiency: 92%/);assert.doesNotMatch(morning.message,/activity:|workouts:|total cals:/);
 records[0].contributors.deep_sleep=60;assert.match(checkInNotification('morning','2026-09-27',records).message,/👎🏻/);
 const afternoon=checkInNotification('afternoon','2026-09-27',records);assert.equal(afternoon.title,'☁️ good afternoon! ☁️');assert.match(afternoon.message,/total cals: 1800 kcal/);assert.match(afternoon.message,/workouts:\n• morning walk/);assert.doesNotMatch(afternoon.message,/running/);
});
