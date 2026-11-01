import { recoveryHistory } from './recovery-history.mjs';
import { sleepTiming } from './sleep-timing.mjs';
import { performanceSummary } from './workout-performance.mjs';
// Compute facts before asking a model to interpret them. No account identifiers,
// raw traces or credentials leave this module. Workout labels are included at the user’s request.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const shift = (day, offset) => new Date(Date.parse(day+'T12:00:00Z')+offset*86400000).toISOString().slice(0,10);
const median = values => {
  const sorted=values.filter(finite).sort((a,b)=>a-b), n=sorted.length;
  return n ? (sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2 : null;
};
function facts(records) {
  const find=type=>records.find(r=>r.type===type);
  const sleeps=records.filter(r=>r.type==='sleep');
  const main=sleeps.filter(r=>r.type_of_sleep==='long_sleep').sort((a,b)=>(b.total_sleep_duration??0)-(a.total_sleep_duration??0))[0]
    ?? sleeps.sort((a,b)=>(b.total_sleep_duration??0)-(a.total_sleep_duration??0))[0];
  const value=v=>finite(v)?v:null;
  return {
    sleep_score:value(find('daily_sleep')?.score), readiness_score:value(find('daily_readiness')?.score),
    sleep_minutes:finite(main?.total_sleep_duration)?Math.round(main.total_sleep_duration/60):null,
    deep_sleep_minutes:finite(main?.deep_sleep_duration)?Math.round(main.deep_sleep_duration/60):null,
    rem_sleep_minutes:finite(main?.rem_sleep_duration)?Math.round(main.rem_sleep_duration/60):null,
    deep_sleep_contributor_score:value(find('daily_sleep')?.contributors?.deep_sleep),
    sleep_efficiency_percent:value(main?.efficiency), hrv_ms:value(main?.average_hrv),
    lowest_sleep_heart_rate_bpm:value(main?.lowest_heart_rate),
    temperature_deviation_c:value(find('daily_readiness')?.temperature_deviation),
    stress_high_minutes:finite(find('daily_stress')?.stress_high)?Math.round(find('daily_stress').stress_high/60):null, restorative_minutes:finite(find('daily_stress')?.recovery_high)?Math.round(find('daily_stress').recovery_high/60):null,
    steps:value(find('daily_activity')?.steps), active_calories:value(find('daily_activity')?.active_calories), total_calories:value(find('daily_activity')?.total_calories)
  };
}
export function buildAnalysisContext(day,records,cycle=null) {
  const from=shift(day,-28), threeDays=shift(day,-2);
  const eligible=records.filter(r=>r.day>=from&&r.day<=day);
  const today=facts(eligible.filter(r=>r.day===day));
  const history=[];
  for(let i=28;i>=1;i--) {
    const date=shift(day,-i), rows=eligible.filter(r=>r.day===date);
    if(rows.length) history.push({day:date,...facts(rows)});
  }
  const baseline={};
  for(const metric of ['sleep_score','readiness_score','sleep_minutes','hrv_ms','lowest_sleep_heart_rate_bpm']) {
    const values=history.map(r=>r[metric]).filter(finite);
    const center=values.length>=7?median(values):null;
    baseline[metric]={sample_days:values.length,median:center,current_delta_percent:center>0&&finite(today[metric])?Math.round((today[metric]-center)/center*1000)/10:null,current_delta:center!==null&&finite(today[metric])?Math.round((today[metric]-center)*100)/100:null};
  }
  const workouts=eligible.filter(r=>r.type==='workout'&&r.day>=threeDays).map(r=>{
    const elapsed=finite(r.duration_seconds)?r.duration_seconds*1000:Date.parse(r.end_datetime)-Date.parse(r.start_datetime);
    return {performance:performanceSummary(r),day:r.day,start_datetime:Number.isFinite(Date.parse(r.start_datetime))?r.start_datetime:null,
      label:typeof r.label==='string'?r.label.replace(/[\r\n\t]/g,' ').slice(0,100).toLowerCase():null,activity:typeof r.activity==='string'?r.activity.slice(0,80):'unknown',
      duration_minutes:Number.isFinite(elapsed)&&elapsed>=0&&elapsed<=86400000?Math.round(elapsed/60000):null,
      intensity:['easy','moderate','hard'].includes(r.intensity)?r.intensity:null};
  });
  let cycleContext={available:false,reason:'Oura Cycle Insights is not available through the integrated API.'};
  if(cycle && /^\d{4}-\d{2}-\d{2}$/.test(cycle.observedDay)) {
    const elapsed=Math.round((Date.parse(day+'T12:00:00Z')-Date.parse(cycle.observedDay+'T12:00:00Z'))/86400000);
    if(elapsed>=0 && elapsed<=7) cycleContext={available:true,source:'Manually copied by user from Oura',observed_day:cycle.observedDay,
      cycle_day:elapsed===0?cycle.cycleDay:null,last_reported_cycle_day:cycle.cycleDay,
      phase:elapsed===0?cycle.phase:null,last_reported_phase:cycle.phase,
      limitation:elapsed===0?'User-reported phase, not independently confirmed. Phase alone does not establish energy or training readiness.':'Historical observation only; current phase and cycle day are unknown. Update from Oura.'};
  }
  const historicalWorkouts=records.filter(r=>r.type==='workout'&&r.day<day&&r.day>=shift(day,-180)).sort((a,b)=>b.day.localeCompare(a.day)).slice(0,8).map(r=>({day:r.day,activity:r.activity,label:r.label||null,performance:performanceSummary(r),before:facts(records.filter(x=>x.day===r.day)),next_day:r.day<shift(day,-1)?facts(records.filter(x=>x.day===shift(r.day,1))):null}));
  return {recovery_history:recoveryHistory(day,records,facts),sleep_timing:sleepTiming(records.filter(r=>r.day===day)),historical_workouts:historicalWorkouts,historical_workout_limitations:'Up to eight most recent workouts in 180 days, not matched for terrain or effort. Associations do not establish cause. Same-day sleep/readiness are not guaranteed pre-run for overnight workouts. Next-day records may be incomplete.',day,unavailable_fields:['step_count_goal','sleep_debt'],metrics:today,cycle:cycleContext,baseline:{window:'Previous 28 calendar days, excluding the current day',minimum_sample_days:7,metrics:baseline},
    recent_days:history.slice(-7),workouts:{window:'Current and preceding two Oura calendar days',count:workouts.length,items:workouts,
      limitation:'Count alone is not training load. Duration and intensity can be unavailable; missing workouts may not have synced.'}};
}
