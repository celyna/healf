import test from 'node:test';
import assert from 'node:assert/strict';
import {Analyzer} from '../src/llm.mjs';
const config={llmEnabled:true,openaiKey:'test-key',openaiModel:'gpt-5-mini',llmMaxDaily:12,llmIntervalSeconds:1800};
const context={day:'2026-09-27',cycle:{available:false},metrics:{readiness_score:70}};
function memory(){const map=new Map();return{get:(k,f=null)=>map.has(k)?map.get(k):f,set:(k,v)=>map.set(k,v)};}
const complete=()=>new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({recovery:'Readiness is 70; baseline data is limited.',workout:'',sleep:'',cycle:'Invented phase'})}]}]}));
test('API payload uses store:false, excludes credentials from inputs, and caches exact context',async()=>{
  const store=memory();let count=0;
  const a=new Analyzer(config,store,async(url,options)=>{
    count++;assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);
    assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.ok(!body.input.includes('test-key'));return complete();
  });
  const first=await a.analyze(context);assert.equal(first.status,'generated');assert.ok(!first.text.includes('Invented'));
  assert.equal((await a.analyze(context)).status,'cached');assert.equal(count,1);
});
test('new context during cooldown is not given stale advice',async()=>{
  const a=new Analyzer(config,memory(),async()=>complete());await a.analyze(context);
  const next=await a.analyze({...context,metrics:{readiness_score:40}});assert.equal(next.status,'limited');assert.equal(next.text,'');
});
test('failures, incomplete output and refusals return metrics-only fallback',async()=>{
  for(const result of [new Response('',{status:429}),new Response(JSON.stringify({status:'incomplete'})),new Response(JSON.stringify({status:'completed',output:[{content:[{type:'refusal'}]}]}))]){
    const store=memory(),a=new Analyzer(config,store,async()=>result);
    assert.equal((await a.analyze(context)).status,'failed');assert.ok(store.get('error:llm'));
  }
});
test('disabled integration sends no data and daily cap bounds attempted API calls',async()=>{
  let calls=0;const store=memory(),fetcher=async()=>{calls++;return complete();};
  assert.equal((await new Analyzer({...config,openaiKey:''},store,fetcher).analyze(context)).status,'disabled');assert.equal(calls,0);
  store.set('llm:usage',{date:new Date().toISOString().slice(0,10),count:12});
  assert.equal((await new Analyzer(config,store,fetcher).analyze(context)).status,'limited');assert.equal(calls,0);
});
test('afternoon and bedtime payloads exclude workouts older than yesterday',async()=>{
 for(const slot of ['afternoon','bedtime']){
 const a=new Analyzer(config,memory(),async(url,options)=>{const input=JSON.parse(JSON.parse(options.body).input);assert.equal(input.workouts.recent_count,2);assert.ok(!JSON.stringify(input.workouts).includes('older-run'));return complete();});
 await a.analyze({...context,check_in:{slot},workouts:{count:3,items:[{day:'2026-09-25',activity:'older-run'},{day:'2026-09-26',activity:'walking'},{day:'2026-09-27',activity:'yoga'}]}});
 }
});
