const finite=v=>typeof v==='number'&&Number.isFinite(v);
const units={heartRateData:{bpm:1,'count/min':1,count:1},runningSpeed:{'m/s':1,kmph:1/3.6,'km/h':1/3.6,mph:0.44704},walkingSpeed:{'m/s':1,kmph:1/3.6,'km/h':1/3.6,mph:0.44704},cyclingSpeed:{'m/s':1,kmph:1/3.6,'km/h':1/3.6,mph:0.44704},runningPower:{W:1,w:1},cyclingPower:{W:1,w:1},stepCadence:{spm:1,'count/min':1},cyclingCadence:{rpm:1,'count/min':1}};
function date(v){if(typeof v!=='string'||!/(Z|[+-]\d{2}:?\d{2})$/.test(v))return NaN;return Date.parse(v.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/,'$1T$2$3:$4'));}
function q(v,factors){return v&&finite(v.qty)&&v.qty>=0&&Object.hasOwn(factors,v.units)?v.qty*factors[v.units]:null;}
export function performance(w,start,end){
 const series={};let omitted=0;
 for(const [name,factors] of Object.entries(units)){
  if(!Array.isArray(w[name]))continue;
  if(w[name].length>20000)throw Error('Too many workout samples; select minute grouping');
  const byTime=new Map();
  for(const p of w[name]){const t=date(p.date),v=p.Avg??p.qty;
   if(!Number.isFinite(t)||t<start||t>end||!finite(v)||v<0||!Object.hasOwn(factors,p.units)){omitted++;continue;}
   byTime.set(t,{at:new Date(t).toISOString(),value:v*factors[p.units]});
  }
  if(byTime.size)series[name]=[...byTime.values()].sort((a,b)=>a.at.localeCompare(b.at));
 }
 const summary={average_hr_bpm:q(w.avgHeartRate??w.heartRate?.avg,{bpm:1,'count/min':1}),max_hr_bpm:q(w.maxHeartRate??w.heartRate?.max,{bpm:1,'count/min':1}),average_speed_mps:q(w.avgSpeed??w.speed,units.runningSpeed),running_power_watts:q(w.runningPower,units.runningPower),cadence_spm:q(w.stepCadence,units.stepCadence)};
 return {version:1,summary,series,omitted_samples:omitted};
}
export function performanceSummary(r){
 const p=r.performance;if(!p)return null;
 const distance=finite(r.distance)?r.distance:null,duration=finite(r.duration_seconds)?r.duration_seconds:(Date.parse(r.end_datetime)-Date.parse(r.start_datetime))/1000;
 const series=Object.fromEntries(Object.entries(p.series||{}).map(([k,rows])=>{
  const avg=a=>a.length?Math.round(a.reduce((s,r)=>s+r.value,0)/a.length*10)/10:null;
  const lo=Date.parse(r.start_datetime),span=Date.parse(r.end_datetime)-lo;
  return [k,{sample_count:rows.length,sample_mean:avg(rows),first_third_mean:avg(rows.filter(v=>Date.parse(v.at)<lo+span/3)),last_third_mean:avg(rows.filter(v=>Date.parse(v.at)>=lo+span*2/3))}];
 }));
 return {...p.summary,distance_m:distance,duration_seconds:finite(duration)?duration:null,average_pace_seconds_per_mile:distance>0&&duration>0?Math.round(duration/distance*1609.344):null,sampled_trends:series,limitations:'Pace uses exported duration and distance, not guaranteed moving time. Sample means are not time-weighted; gaps and pauses may distort trends. HR and speed samples are not necessarily aligned. Terrain, weather and perceived effort are unknown.'};
}
