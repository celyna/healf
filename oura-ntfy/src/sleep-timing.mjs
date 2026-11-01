// User-provided Oura Body Clock target; independent of measured sleep history.
export function configuredSleepTarget(env=process.env) {
 const values=[env.SLEEP_TARGET_BEDTIME,env.SLEEP_TARGET_MIDPOINT,env.SLEEP_TARGET_WAKE];
 if(values.every(v=>!v))return null;
 if(!values.every(v=>/^([01]\d|2[0-3]):[0-5]\d$/.test(v||'')))throw Error('Set all three SLEEP_TARGET times as HH:MM');
 const timezone=env.SLEEP_TARGET_TIMEZONE||env.LLM_TIMEZONE||'UTC';
 new Intl.DateTimeFormat('en-US',{timeZone:timezone}).format();
 return {chronotype:env.SLEEP_CHRONOTYPE||'unspecified',bedtime:values[0],midpoint:values[1],wake:values[2],timezone,source:'user-provided Oura Body Clock'};
}
const minutes=s=>Number(s.slice(0,2))*60+Number(s.slice(3));
const clockMinutes = (ms,timezone) => {const p=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(ms);return Number(p.find(x=>x.type==='hour').value)*60+Number(p.find(x=>x.type==='minute').value);};
const delta=(actual,target)=>(actual-target+2160)%1440-720;
export function sleepTiming(records,sleepTarget=configuredSleepTarget()){
 if(!sleepTarget)return {available:false,reason:"No personal sleep target configured"};
 const sleeps=records.filter(r=>r.type==='sleep');
 const main=sleeps.filter(r=>r.type_of_sleep==='long_sleep').sort((a,b)=>(b.total_sleep_duration??0)-(a.total_sleep_duration??0))[0]??sleeps.sort((a,b)=>(b.total_sleep_duration??0)-(a.total_sleep_duration??0))[0];
 const start=Date.parse(main?.bedtime_start),end=Date.parse(main?.bedtime_end);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>24*3600000)return {target:sleepTarget,available:false};
 return {target:sleepTarget,available:true,bedtime_offset_minutes:delta(clockMinutes(start,sleepTarget.timezone),minutes(sleepTarget.bedtime)),bed_interval_midpoint_offset_minutes:delta(clockMinutes(start+(end-start)/2,sleepTarget.timezone),minutes(sleepTarget.midpoint)),wake_offset_minutes:delta(clockMinutes(end,sleepTarget.timezone),minutes(sleepTarget.wake)),limitations:'Positive offsets mean later than target. Bedtime and midpoint describe the recorded bed interval, not exact sleep onset or sleep-weighted midpoint. A timing mismatch does not establish a recovery effect. No cycle counts, wake-stage claims or predicted cycle-end alarms are available.'};
}
