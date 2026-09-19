import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadRecords,protectRecords,runPolicies,runPass1,parseArguments} from '../src/filter-transcript.mjs';
import {recoveryEvidence} from '../src/codex.mjs';
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
    assert.ok(fixture(t,exchange(format,'a'),5).records.every(r=>r.removed === 'empty-noop-exchange'));
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

const human = format => format === 'codex'
  ? {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Continue the work'}]}}
  : {type:'user',message:{content:'Continue the work'}};
const tap = `TAP version 13
# Subtest: PASSING_DETAIL_SENTINEL
ok 1 - PASSING_DETAIL_SENTINEL
  ---
  duration_ms: 1.23
  type: 'test'
  ...
# Subtest: failing case
not ok 2 - failing case
  ---
  error: 'EXPECTED_DIAGNOSTIC'
  ...
1..2
# tests 2
# pass 1
# fail 1
`;
function failedExchange(format,id,output='failure evidence') {
  const entries=exchange(format,id,'node --test',output);
  if(format==='codex') entries[1].payload.output=JSON.stringify({exit_code:1,output});
  else entries[1].message.content[0].is_error=true;
  return entries;
}
test('default protected tail is five records',()=>assert.equal(parseArguments(['-']).keepTail,5));
for(const format of ['codex','claude']) {
  test(`${format}: failed exchanges expire at exactly two human turns, despite tail and pins`,t=>{
    for(const age of [0,1,2]) {
      const entries=[human(format),...failedExchange(format,'failure'),...Array.from({length:age},()=>human(format))];
      const {records}=fixture(t,entries,20);
      assert.deepEqual(records.slice(1,3).map(r=>r.removed??null), age===2 ? ['expired-tool-failure','expired-tool-failure'] : [null,null]);
      const recovery=recoveryEvidence(records);
      assert.equal(recovery.includes('failure evidence'),age<2);
      const ranking=prepareRecoveryRanking(records,{model:'mock'});
      if(age===2) assert.ok(ranking.candidates.every(p=>p.entry!==2));
    }
    const entries=[human(format),...failedExchange(format,'a'),...exchange(format,'b','echo done','done')];
    assert.ok(fixture(t,entries,20).records.slice(1,3).every(r=>!r.removed));
    const split=failedExchange(format,'split');
    const {records}=fixture(t,[human(format),split[0],human(format),split[1],human(format)],20);
    assert.ok(records.every(r=>!r.removed));
  });
  test(`${format}: complete TAP removes passing detail before ranking, recovery and export`,async t=>{
    const {records,input,raw,dir}=fixture(t,[human(format),...failedExchange(format,'tap',tap)],5);
    assert.ok(records.every(r=>!r.removed));
    assert.ok(!records[2].text.includes('PASSING_DETAIL_SENTINEL'));
    assert.match(records[2].text,/EXPECTED_DIAGNOSTIC/);
    assert.match(records[2].text,/# tests 2/);
    assert.match(records[2].text,/# pass 1/);
    assert.match(records[2].text,/# fail 1/);
    const ranking=prepareRecoveryRanking(records,{model:'mock'});
    assert.ok(!JSON.stringify(ranking).includes('PASSING_DETAIL_SENTINEL'));
    if(format==='codex') assert.ok(ranking.candidates.filter(p=>p.entry===2).every(p=>p.field==='normalized_output'));
    assert.ok(!recoveryEvidence(records).includes('PASSING_DETAIL_SENTINEL'));
    const out=join(dir,'out');
    const result=spawnSync(process.execPath,['src/filter-transcript.mjs',input,'--offline','--out',out],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.ok(!readFileSync(out,'utf8').includes('PASSING_DETAIL_SENTINEL'));
    assert.equal(readFileSync(input,'utf8'),raw);
    const success=tap.replace('not ok 2','ok 2').replace('# fail 1','# fail 0');
    const kept=fixture(t,[...exchange(format,'success','node --test',success),human(format),human(format)],5).records;
    assert.ok(kept.every(r=>!r.removed));
    assert.match(kept[1].text,/# fail 0/);
  });
  test(`${format}: incomplete TAP, file reads and unknown/mixed failure schemas remain intact`,t=>{
    for(const command of ['cat results.tap','echo test']) {
      const {records}=fixture(t,exchange(format,'read',command,tap),5);
      assert.ok(records[1].text.includes('PASSING_DETAIL_SENTINEL'));
    }
    const partial=fixture(t,exchange(format,'partial','node --test',tap.replace('# fail 1','')),5);
    assert.ok(partial.records[1].text.includes('PASSING_DETAIL_SENTINEL'));
    for(const kind of ['unknown','mixed','truncated','duplicate']) {
      const pair=failedExchange(format,kind,tap);
      if(kind==='unknown') pair[1].unknown='evidence';
      if(kind==='mixed') { if(format==='claude') pair[1].message.content.push({type:'text',text:'constraint'}); else pair[1].payload.unknown='constraint'; }
      if(kind==='truncated') { if(format==='claude') pair[1].message.content[0].content+='Output truncated'; else pair[1].payload.output=JSON.stringify({exit_code:1,output:tap,original_token_count:1000}); }
      if(kind==='duplicate') pair.push(structuredClone(pair[1]));
      const {records}=fixture(t,[...pair,human(format),human(format)],20);
      assert.ok(records.every(r=>!r.removed));
      assert.ok(records[1].text.includes('PASSING_DETAIL_SENTINEL'));
    }
  });
}

test('explicit adapter error objects expire without inventing an exit code',t=>{
  for(const age of [0,1,2]) {
    const pair=exchange('codex','adapter','node --test');
    pair[0].payload.name='bash';
    pair[1].payload.output={output:'adapter failure diagnostic',is_error:true};
    const {records}=fixture(t,[...pair,...Array.from({length:age},()=>human('codex'))],5);
    assert.equal(records.slice(0,2).every(r=>r.removed==='expired-tool-failure'),age===2);
    assert.equal(recoveryEvidence(records).includes('adapter failure diagnostic'),age<2);
  }
});

test('Node spec passing cases shrink while failed diagnostics and final counters survive',t=>{
  const output='✔ PASSING_DETAIL_SENTINEL (1.25ms)\n✖ failing case (2ms)\n  EXPECTED_DIAGNOSTIC\nℹ tests 2\nℹ pass 1\nℹ fail 1\n';
  const {records}=fixture(t,failedExchange('codex','spec',output),5);
  assert.ok(!records[1].text.includes('PASSING_DETAIL_SENTINEL'));
  for(const line of ['✖ failing case','EXPECTED_DIAGNOSTIC','ℹ tests 2','ℹ pass 1','ℹ fail 1']) assert.ok(records[1].text.includes(line));
});
test('normalized explicit adapter failures preserve error status on export and ranking provenance',t=>{
  const pair=exchange('codex','adapter','node --test');
  pair[0].payload.name='bash';pair[1].payload.output={output:tap,is_error:true};
  const {records,input,dir}=fixture(t,pair,5);
  assert.equal(records[1].entry.payload.output.is_error,true);
  const ranking=prepareRecoveryRanking(records,{model:'mock'});
  assert.ok(ranking.candidates.length);
  assert.ok(ranking.candidates.every(p=>p.field==='normalized_output.output'));
  const out=join(dir,'out');
  const result=spawnSync(process.execPath,['src/filter-transcript.mjs',input,'--offline','--out',out],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const exported=readFileSync(out,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(exported[1].payload.output.is_error,true);
  assert.ok(!exported[1].payload.output.output.includes('PASSING_DETAIL_SENTINEL'));
});
