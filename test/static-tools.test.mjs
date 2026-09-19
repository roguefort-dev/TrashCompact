import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadRecords,protectRecords,runPolicies,runPass1} from '../src/filter-transcript.mjs';
import {prepareRecoveryRanking,scoreRecoveryRanking} from '../src/recovery-rank.mjs';
const shellResult = output => JSON.stringify({exit_code:0,output,wall_time_seconds:0.1});
function exchange(format,id,command='true',output='',extra={}) {
  if(format==='codex') return [
    {type:'response_item',payload:{type:'function_call',call_id:id,name:'exec_command',arguments:JSON.stringify({cmd:command,workdir:'/repo'})}},
    {type:'response_item',payload:{type:'function_call_output',call_id:id,output:shellResult(output),...extra}},
  ];
  return [
    {type:'assistant',cwd:'/repo',message:{content:[{type:'tool_use',id,name:'Bash',input:{command}}]}},
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:output,is_error:false,...extra}]}},
  ];
}
function fixture(t,entries,tail=0) {
  const dir=mkdtempSync(join(tmpdir(),'static-tools-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const input=join(dir,'input.jsonl'),raw=entries.map(e=>JSON.stringify(e)).join('\n');writeFileSync(input,raw);
  const {records}=loadRecords(input);protectRecords(records,tail);runPolicies(records,tail);return {records,input,raw,dir};
}
for(const format of ['codex','claude']) {
  test(`${format}: successful empty noop pairs drop atomically`,t=>{
    for(const command of ['true',':','sleep 0.1','clear']) {
      const {records}=fixture(t,exchange(format,'a',command));assert.deepEqual(records.map(r=>r.removed),['empty-noop-exchange','empty-noop-exchange']);
    }
  });
  test(`${format}: incomplete, errors, mixed, unknown and meaningful commands survive`,t=>{
    for(const command of ['false','true; rm x','echo done','git status','npm test','rg absent','sleep 1 && true']) assert.ok(fixture(t,exchange(format,'a',command)).records.every(r=>!r.removed));
    assert.ok(fixture(t,exchange(format,'a','true','meaningful')).records.every(r=>!r.removed));
    assert.ok(fixture(t,exchange(format,'a').slice(0,1)).records.every(r=>!r.removed));
    for(const output of ['success',...(format==='codex'?['']:[]),JSON.stringify({exit_code:1,output:''}),JSON.stringify({exit_code:0,session_id:7,output:''})]) {
      const entries=exchange(format,'a');if(format==='codex') entries[1].payload.output=output;else entries[1].message.content[0].content=output;
      assert.ok(fixture(t,entries).records.every(r=>!r.removed));
    }
    if(format==='claude') {
      assert.ok(fixture(t,exchange(format,'a','true','',{is_error:true})).records.every(r=>!r.removed));
      const hidden=exchange(format,'a');hidden[0].isSidechain=true;assert.ok(fixture(t,hidden).records.every(r=>!r.removed));
      const routed=exchange(format,'a');routed[0].message.recipient='other';assert.ok(fixture(t,routed).records.every(r=>!r.removed));
    }
    const annotated=exchange(format,'a');annotated[0].extra='constraint';assert.ok(fixture(t,annotated).records.every(r=>!r.removed));
    const ambiguous=exchange(format,'a');ambiguous.push(structuredClone(ambiguous[1]));assert.ok(fixture(t,ambiguous).records.every(r=>!r.removed));
    const mixed=exchange(format,'a');if(format==='claude') mixed[0].message.content.push({type:'text',text:'constraint'});else mixed[0].payload.unknown='constraint';
    assert.ok(fixture(t,mixed).records.every(r=>!r.removed));
    assert.ok(fixture(t,exchange(format,'a'),1).records.every(r=>!r.removed));
  });
  test(`${format}: exact read pairs retain latest; changes and actions break dedup`,t=>{
    const first=exchange(format,'a','cat config.txt','exact evidence');
    const second=exchange(format,'b','cat config.txt','exact evidence');
    assert.deepEqual(fixture(t,[...first,...second]).records.map(r=>r.removed??null),['exact-read-repeat','exact-read-repeat',null,null]);
    assert.ok(fixture(t,[...first,...exchange(format,'b','cat config.txt','changed')]).records.every(r=>!r.removed));
    assert.ok(fixture(t,[...first,...exchange(format,'w','touch config.txt'),...second]).records.every(r=>!r.removed));
    const human=format==='codex'?{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'read again'}]}}:{type:'user',message:{content:'read again'}};
    assert.ok(fixture(t,[...first,human,...second]).records.every(r=>!r.removed));
    if(format==='codex') second[0].payload.arguments=JSON.stringify({cmd:'cat config.txt',workdir:'/different'});else second[0].cwd='/different';
    assert.ok(fixture(t,[...first,...second]).records.every(r=>!r.removed));
  });
}
test('Claude Read duplicates require explicit success and preserve mixed results',t=>{
  const pair=id=>[{type:'assistant',cwd:'/repo',message:{content:[{type:'tool_use',id,name:'Read',input:{file_path:'/repo/a'}}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:'file content',is_error:false}]}}];
  assert.equal(fixture(t,[...pair('a'),...pair('b')]).records.filter(r=>r.removed).length,2);
  const entries=[...pair('a'),...pair('b')];delete entries[1].message.content[0].is_error;assert.ok(fixture(t,entries).records.every(r=>!r.removed));
});
test('Codex telemetry and empty visible messages prune; unknown payloads stay',t=>{
  const entries=[{type:'event_msg',payload:{type:'token_count',info:{},rate_limits:null}}, {type:'response_item',payload:{type:'message',role:'assistant',content:[]}}, {type:'event_msg',payload:{type:'token_count',unknown:'evidence'}}];
  assert.deepEqual(fixture(t,entries).records.map(r=>!!r.removed),[true,true,false]);
});
test('CLI plan/offline output prune before scoring and preserve original source bytes',t=>{
  const {input,raw,dir}=fixture(t,[...exchange('codex','a'),...exchange('codex','b','cat file','evidence'),...exchange('codex','c','cat file','evidence')]);
  const plan=spawnSync(process.execPath,['src/filter-transcript.mjs',input,'--plan','--keep-tail','0'],{encoding:'utf8'});assert.equal(plan.status,0,plan.stderr);assert.match(plan.stdout,/removed by rule\s+4/);
  const out=join(dir,'out');const result=spawnSync(process.execPath,['src/filter-transcript.mjs',input,'--offline','--keep-tail','0','--out',out],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const kept=readFileSync(out,'utf8').trim().split('\n').map(JSON.parse);assert.equal(kept.length,2);assert.deepEqual(kept.map(e=>e.payload.call_id),['c','c']);assert.equal(readFileSync(input,'utf8'),raw);
});
test('removed records never enter mocked whole-entry or passage Jev requests',async t=>{
  const {records}=fixture(t,[...exchange('codex','a'),...exchange('codex','b','cat file','retained evidence'),...exchange('codex','c','cat file','retained evidence')]);
  const prepared=prepareRecoveryRanking(records,{model:'mock'});assert.ok(prepared.candidates.length);assert.ok(prepared.candidates.every(p=>p.entry===5));
  const requests=[],sdk={score:()=>({}),choice:()=>({})},client={systemOne:async request=>{requests.push(request);return {answers:{}};}};
  const removed={category:'prose',text:'REMOVED SECRET MARKER',removed:'exact-repeat'};
  await runPass1(client,sdk,[removed,...records],{batch:8,chars:1200},{requests:0});
  await scoreRecoveryRanking(client,sdk,prepared,{requests:0});
  assert.ok(requests.length);assert.ok(!JSON.stringify(requests).includes('REMOVED SECRET MARKER'));assert.ok(!JSON.stringify(requests).includes('exit_code\\\":0,\\\"output\\\":\\\"\\\"'));
});
