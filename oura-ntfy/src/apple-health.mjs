import { performance } from './workout-performance.mjs';
import {createHash} from 'node:crypto';
import {localClock} from './schedule.mjs';
const clean=s=>String(s).replace(/[\r\n\t]/g,' ').slice(0,100).toLowerCase();
function timestamp(s){if(typeof s!=='string'||!/(Z|[+-]\d{2}:?\d{2})$/.test(s))throw Error('Timestamps must include timezone');const n=Date.parse(s.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/,'$1T$2$3:$4'));if(!Number.isFinite(n))throw Error('Invalid timestamp');return n;}
function quantity(v,factors){if(v==null)return null;if(typeof v.qty!=='number'||!Number.isFinite(v.qty)||v.qty<0||!Object.hasOwn(factors,v.units))throw Error('Invalid quantity or unit');return v.qty*factors[v.units];}
export function parseWorkouts(payload,timezone){
 const rows=payload?.data?.workouts??payload?.workouts;if(!Array.isArray(rows)||rows.length>500)throw Error('Expected at most 500 workouts');
 return rows.map(w=>{if(!w||typeof w.id!=='string'||!w.id||w.id.length>200||typeof w.name!=='string'||!w.name.trim())throw Error('Version 2 workout id and name required');
 const start=timestamp(w.start),end=timestamp(w.end);if(end<=start||end-start>7*86400000||end>Date.now()+86400000)throw Error('Invalid workout time range');
 if(typeof w.duration!=='number'||!Number.isFinite(w.duration)||w.duration<0||w.duration>(end-start)/1000+60)throw Error('Invalid duration');
 return {id:'apple:'+createHash('sha256').update(w.id).digest('hex'),day:localClock(start,timezone).day,activity:clean(w.name),label:clean((w.location==='Outdoor'?'outdoor ':w.location==='Indoor'?'indoor ':'')+w.name),start_datetime:new Date(start).toISOString(),end_datetime:new Date(end).toISOString(),duration_seconds:w.duration,distance:quantity(w.distance,{mi:1609.344,km:1000,m:1}),calories:quantity(w.activeEnergyBurned,{kcal:1,kJ:1/4.184}),source:'apple_health',intensity:null,performance:performance(w,start,end)};
 });
}
const category=s=>String(s||'').toLowerCase().replace(/outdoor|indoor/g,'').replace(/[^a-z]/g,'').replace(/^running$/,'run').replace(/^walking$/,'walk').replace(/^(cycling|biking)$/,'cycle');
export function mergeWorkouts(records){
 const apple=records.filter(r=>r.type==='apple_workout').map(r=>({...r,type:'workout'}));
 const used=new Set();const rest=records.filter(r=>{if(r.type==='apple_workout')return false;if(r.type!=='workout')return true;
 const i=apple.findIndex((a,i)=>!used.has(i)&&category(a.activity)===category(r.activity)&&Math.abs(Date.parse(a.start_datetime)-Date.parse(r.start_datetime))<=120000&&Math.abs(Date.parse(a.end_datetime)-Date.parse(r.end_datetime))<=120000);
 if(i>=0){used.add(i);return false;}return true;});return [...rest,...apple];
}
