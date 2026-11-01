import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sleepTiming,configuredSleepTarget} from '../src/sleep-timing.mjs';
const target={bedtime:'23:00',midpoint:'03:00',wake:'07:00',timezone:'America/Los_Angeles'};
test('configurable target matches overnight Pacific interval',()=>{const r=sleepTiming([{type:'sleep',bedtime_start:'2026-10-03T23:00:00-07:00',bedtime_end:'2026-10-04T07:00:00-07:00'}],target);assert.equal(r.bedtime_offset_minutes,0);assert.equal(r.bed_interval_midpoint_offset_minutes,0);assert.equal(r.wake_offset_minutes,0);});
test('midnight wrap and winter offset',()=>{assert.equal(sleepTiming([{type:'sleep',bedtime_start:'2026-12-03T00:05:00-08:00',bedtime_end:'2026-12-03T08:05:00-08:00'}],target).bedtime_offset_minutes,65);assert.equal(sleepTiming([],target).available,false);});
test('missing targets stay unavailable and partial/invalid configuration rejected',()=>{assert.equal(configuredSleepTarget({}),null);assert.equal(sleepTiming([],null).available,false);assert.throws(()=>configuredSleepTarget({SLEEP_TARGET_BEDTIME:'25:00'}));assert.throws(()=>configuredSleepTarget({SLEEP_TARGET_BEDTIME:'23:00'}));});
