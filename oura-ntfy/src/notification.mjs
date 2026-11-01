import { performanceSummary } from './workout-performance.mjs';
const number=v=>typeof v==='number'&&Number.isFinite(v);
const show=(v,unit='')=>number(v)?`${Math.round(v*10)/10}${unit}`:'not synced yet';
export function hhmm(seconds){if(!number(seconds)||seconds<0)return 'not synced yet';const m=Math.floor(seconds/60);return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;}
export function sleepDuration(seconds){if(!number(seconds)||seconds<0)return 'not synced yet';const m=Math.round(seconds/60);return `${Math.floor(m/60)}h ${m%60}m`;}
export function checkInNotification(slot,day,records,analysis=''){
 const find=t=>records.find(r=>r.type===t);
 const sleeps=records.filter(r=>r.type==='sleep');
 const main=sleeps.filter(r=>r.type_of_sleep==='long_sleep').sort((a,b)=>(b.total_sleep_duration??0)-(a.total_sleep_duration??0))[0]??sleeps.sort((a,b)=>(b.total_sleep_duration??0)-(a.total_sleep_duration??0))[0];
 const title=slot==='morning'?`☀️ gm! it’s ${day.slice(5).replace('-','/')} ☀️`:slot==='afternoon'?'☁️ good afternoon! ☁️':'🌙 gn! it’s time to wind down 🌙';
 const a=find('daily_activity'),stress=find('daily_stress');
 const lines=slot==='morning'?[
 `sleep: ${show(find('daily_sleep')?.score,'/100')}`,
 `deep sleep: ${sleepDuration(main?.deep_sleep_duration)}${number(main?.deep_sleep_duration)&&number(find('daily_sleep')?.contributors?.deep_sleep)?(find('daily_sleep').contributors.deep_sleep>=70?' 👍🏻':' 👎🏻'):''}`,
 `efficiency: ${show(main?.efficiency,'%')}`,
 `rem sleep: ${sleepDuration(main?.rem_sleep_duration)}`,
 `total sleep: ${sleepDuration(main?.total_sleep_duration)}`,
 `readiness: ${show(find('daily_readiness')?.score,'/100')}`,
 `avg hrv: ${show(main?.average_hrv,' ms')}`,
 `lowest hr: ${show(main?.lowest_heart_rate,' bpm')}`,
 `spo2: ${show(find('daily_spo2')?.spo2_percentage?.average,'%')}`
 ]:[`steps: ${number(a?.steps)?a.steps.toLocaleString('en-US'):'not synced yet'}`,
 `active cals: ${show(a?.active_calories,' kcal')}`,
 `total cals: ${show(a?.total_calories,' kcal')}`,
 `stress: ${hhmm(stress?.stress_high)} high stress`,
 `restore: ${hhmm(stress?.recovery_high)} restorative`];
 if(slot!=='morning'){const workouts=records.filter(r=>r.type==='workout'&&r.day===day);lines.push('workouts:',...(workouts.length?workouts.map(r=>{const p=performanceSummary(r),parts=[];if(p){if(number(p.duration_seconds))parts.push(Math.round(p.duration_seconds/60)+' min');if(number(p.distance_m))parts.push((p.distance_m/1609.344).toFixed(2)+' mi');const pace=p.average_pace_seconds_per_mile;if(number(pace)&&/run|walk|hik/i.test(r.activity))parts.push(Math.floor(pace/60)+':'+String(pace%60).padStart(2,'0')+'/mi');if(number(p.average_hr_bpm))parts.push('avg hr '+Math.round(p.average_hr_bpm)+' bpm');else if(p.sampled_trends.heartRateData)parts.push('sample avg hr '+Math.round(p.sampled_trends.heartRateData.sample_mean)+' bpm');if(number(p.max_hr_bpm))parts.push('max hr '+Math.round(p.max_hr_bpm));}return '• '+String(r.label||r.activity||'workout').replaceAll('_',' ').replace(/[\r\n\t]/g,' ').slice(0,100).toLowerCase()+(parts.length?'\n  '+parts.join(' · '):'');}):['• none synced today']));}
 return {title,message:lines.join('\n')+'\n\n'+(analysis.trim().toLowerCase()||'ai note couldn’t load this time — here are ur latest synced stats 🫶')};
}
