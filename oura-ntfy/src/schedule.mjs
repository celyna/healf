export function localClock(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  return {day:parts.year+'-'+parts.month+'-'+parts.day,hour:Number(parts.hour)};
}
export function analysisSlot(now, timezone, records) {
  const {day,hour}=localClock(now,timezone);
  const slot=hour>=22?'bedtime':hour>=13?'afternoon':records.some(r=>r.type==='daily_sleep'&&r.day===day&&r.score!=null)?'morning':null;
  return slot?{day,slot,key:day+':'+slot,timezone}:null;
}
