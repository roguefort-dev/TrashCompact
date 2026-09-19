import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, linkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CATEGORY } from '../src/classify.mjs';
import { parseArguments, loadRecords, protectRecords, dedupPayloads, runPolicies, runPass1, applyRetention, precompactInstructions, loadState, saveState, verdictKey, validRetention } from '../src/filter-transcript.mjs';
const opts = { batch: 8, chars: 1200, threshold: .75, minConfidence: .55, model: 'jev-1.13.0' };
const prose = (text, index=0) => ({ index, category: CATEGORY.PROSE, text, turn: 1, issuedIds: [], answersIds: [], entry: { type:'assistant', message:{content:[{type:'text',text}]} } });
const temporary = (t) => { const dir = mkdtempSync(join(tmpdir(), 'trashcompact-test-')); t.after(() => rmSync(dir,{recursive:true,force:true})); return dir; };
test('numeric CLI ranges, missing values and duplicate inputs fail closed', () => {
  for (const flags of [['--batch','0'], ['--batch','1.5'], ['--keep-tail','-1'], ['--chars','0'], ['--threshold','2.1'], ['--min-confidence','1.1'], ['--out'], ['--state','--offline'], ['--model'], ['--batch','Infinity'], ['--batch','33']])
    assert.throws(() => parseArguments(['input.jsonl', ...flags]), undefined, flags.join(' '));
  assert.throws(() => parseArguments(['a','b']));
  assert.equal(parseArguments(['a','--threshold','2']).threshold,2);
});
test('input/output/state cannot alias through paths, symlinks or hard links', t => {
  const dir = temporary(t), input=join(dir,'input'); writeFileSync(input,'{}');
  symlinkSync(input,join(dir,'sym')); linkSync(input,join(dir,'hard'));
  for(const target of [input,join(dir,'sym'),join(dir,'hard')]) assert.throws(()=>parseArguments([input,'--out',target]));
  assert.throws(()=>parseArguments([input,'--out',join(dir,'new'),'--state',join(dir,'new')]));
});
test('malformed and truncated records fail without creating output', t => {
  const dir=temporary(t), input=join(dir,'input'), output=join(dir,'output');
  for(const raw of ['{}\n{','null\n','[]\n']) { writeFileSync(input,raw); assert.throws(()=>loadRecords(input)); }
  const result=spawnSync(process.execPath,['src/filter-transcript.mjs',input,'--offline','--out',output],{encoding:'utf8'});
  assert.equal(result.status,1); assert.throws(()=>readFileSync(output));
});
test('tail keeps unique prose and cached low scores but drops exact adjacent duplicates', async () => {
  const records=[prose('Keep the API contract.'),prose('Keep the API contract.',1),prose('The migration still needs review.',2)];
  protectRecords(records,5); dedupPayloads(records); runPolicies(records,5);
  for(const r of records) r.retention={score:0,confidence:1};
  applyRetention(records,opts);
  assert.equal(records[0].removed,'exact-repeat');
  assert.ok(records.slice(1).every(r=>!r.removed));
  await runPass1({systemOne:async()=>assert.fail('Recent prose must not be sent to Jev')},{},records,opts,{});
});
for(const format of ['codex','claude']) {
  const message=(role,text)=>format==='codex'
    ? {type:'response_item',payload:{type:'message',role,content:[{type:'text',text}]}}
    : {type:role,message:{content:[{type:'text',text}]}};
  const inspect=(t,entries)=>{
    const input=join(temporary(t),'input.jsonl');writeFileSync(input,entries.map(JSON.stringify).join('\n'));
    const {records}=loadRecords(input);protectRecords(records,5);dedupPayloads(records);runPolicies(records,5);return records;
  };
  test(`${format}: last five records retain context while removing proven empty and local data`,t=>{
    const local=format==='codex'?{type:'event_msg',payload:{type:'token_count',info:{}}}:{type:'file-history-snapshot'};
    const records=inspect(t,[message('user','Preserve this request.'),local,message('assistant',''),message('assistant','Unique reasoning: preserve stable IDs.'),message('assistant','Working on it.')]);
    assert.deepEqual(records.map(record=>record.removed??null),[null,CATEGORY.LOCAL_ONLY,CATEGORY.EMPTY,null,null]);
    assert.ok(records.every(record=>record.tailProtected));
  });
  test(`${format}: tail cleanup retains user messages, thinking, unknown payloads and incomplete calls`,t=>{
    const thinking=format==='codex'?{type:'response_item',payload:{type:'reasoning',summary:[]}}
      : {type:'assistant',message:{content:[{type:'thinking',thinking:'Private reasoning'}]}};
    const unknown=message('assistant','');unknown.extra='Important unknown context';
    const call=format==='codex'?{type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'pending',arguments:'{"cmd":"test"}'}}
      : {type:'assistant',message:{content:[{type:'tool_use',id:'pending',name:'Bash',input:{command:'test'}}]}};
    const mixed=message('assistant','');
    (format==='codex'?mixed.payload.content:mixed.message.content).push({type:'unknown',text:'Keep this evidence'});
    const records=inspect(t,[message('user',''),thinking,unknown,call,mixed]);
    assert.ok(records.every(record=>!record.removed));
    assert.equal(records[3].hardProtected,true);
  });
  test(`${format}: recent duplicate cleanup requires exact text, pure payload and the same human turn`,t=>{
    for(const [a,b] of [['API','api'],['a b','a  b'],['time 1ms','time 2ms']]) {
      assert.ok(inspect(t,[message('assistant',a),message('assistant',b)]).every(record=>!record.removed));
    }
    const duplicated=inspect(t,[message('assistant','Same'),message('assistant','Same'),message('assistant','Same')]);
    assert.deepEqual(duplicated.map(record=>record.removed??null),['exact-repeat','exact-repeat',null]);
    assert.ok(inspect(t,[message('assistant','Same'),message('user','Again'),message('assistant','Same')]).every(record=>!record.removed));
    const unknown=message('assistant','Same');unknown.extra='Do not drop this field';
    assert.ok(inspect(t,[unknown,structuredClone(unknown)]).every(record=>!record.removed));
  });
}
test('dedup preserves case, measurements, IDs, nested payload and roles', () => {
  for(const [a,b] of [['time 1ms','time 2ms'],['sha abcdef0','sha abcdef1'],['API','api'],['a b','a  b']]) {
    const records=[prose(a),prose(b,1)]; dedupPayloads(records); assert.ok(!records[0].removed);
  }
  const records=[prose('same'),prose('same',1)]; records[1].entry.message.extra='evidence'; dedupPayloads(records);assert.ok(!records[0].removed);
  records[1].entry=structuredClone(records[0].entry); records[1].entry.type='user'; dedupPayloads(records);assert.ok(!records[0].removed);
  records[1].entry.type='assistant'; dedupPayloads(records);assert.equal(records[0].removed,'exact-repeat');
});
test('all results are tracked and missing tool results protect calls', t => {
  const dir=temporary(t), input=join(dir,'input');
  writeFileSync(input,JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'a',content:'A'},{type:'tool_result',tool_use_id:'b',content:'B'}]}}));
  assert.deepEqual(loadRecords(input).records[0].answersIds,['a','b']);
  const call={...prose('pending'),category:CATEGORY.TOOL_CALL,issuedIds:['a','b']};
  protectRecords([call,{...prose('answer',1),answersIds:['a']}],0); assert.equal(call.protected,true);
});
test('invalid, uncertain and truncated judgments retain entries', () => {
  for(const retention of [null,{}, {score:NaN,confidence:1},{score:3,confidence:1},{score:-1,confidence:1},{score:0,confidence:2},{score:0,confidence:-1},{score:0,confidence:.1}]) {
    const r={...prose('context'), retention, intent:'narration'}; applyRetention([r],opts);assert.ok(!r.removed);
  }
  const r={...prose('x'.repeat(1201)),retention:{score:0,confidence:1}}; applyRetention([r],opts);assert.ok(!r.removed);
  assert.equal(validRetention({score:2,confidence:1}),true);
});
test('mocked Jev handles missing answers and never submits truncated prefixes', async () => {
  let calls=0;
  const client={systemOne:async()=>{calls++;return {answers:{},usage:{}};}};
  const sdk={score:()=>({}),choice:()=>({})}, records=[prose('short'),prose('x'.repeat(1201),1)];
  await runPass1(client,sdk,records,opts,{input:0,output:0,requests:0});
  assert.equal(calls,1);assert.ok(records.every(r=>!r.retention));
});
test('cache fingerprints invalidate changes in full content, model, and truncation budget', () => {
  const r=prose('original'), key=verdictKey(r,opts);
  assert.notEqual(key,verdictKey(prose('changed'),opts));
  assert.notEqual(key,verdictKey(r,{...opts,model:'other'}));
  assert.notEqual(key,verdictKey(r,{...opts,chars:100}));
});
test('cache invalidates old formats, merges writers and refuses held lock', t => {
  const dir=temporary(t), path=join(dir,'state');
  writeFileSync(path,JSON.stringify({version:1,verdicts:{old:{}}}));assert.deepEqual(loadState(path).verdicts,{});
  const a=loadState(path),b=loadState(path);a.verdicts.a={};b.verdicts.b={};saveState(path,a);saveState(path,b);
  assert.deepEqual(Object.keys(loadState(path).verdicts).sort(),['a','b']);
  mkdirSync(`${path}.lock`);assert.throws(()=>saveState(path,{version:2,verdicts:{c:{}}}));assert.ok(!loadState(path).verdicts.c);
});
test('steering stays within 6000 UTF-8 bytes and preserves failure evidence guidance', () => {
  const records=Array.from({length:40},(_,i)=>({...prose('重大 failure unresolved '.repeat(100),i),category:CATEGORY.HUMAN_INSTRUCTION}));
  records.push({...prose('tool evidence',41),category:CATEGORY.TOOL_CALL,entry:{type:'assistant',message:{content:[{type:'tool_use',name:'Write',input:{file_path:`/src/${'界'.repeat(9000)}.js`}}]}}});
  const text=precompactInstructions(records);assert.ok(Buffer.byteLength(text)<=6000);assert.match(text,/unresolved failures/);assert.match(text,/heuristic/);
  assert.equal(text.includes('\uFFFD'),false);
});
test('independent cache writers merge usage deltas and run counts', t => {
  const path=join(temporary(t),'state'), a=loadState(path), b=loadState(path);
  saveState(path,a,{requests:1,input:10});saveState(path,b,{requests:2,input:20});
  assert.deepEqual(loadState(path).usage,{requests:3,input:30,output:0});assert.equal(loadState(path).runs,2);
});
test('same basename transcripts have different default caches', t => {
  const dir=temporary(t);mkdirSync(join(dir,'a'));mkdirSync(join(dir,'b'));
  const a=join(dir,'a','session.jsonl'), b=join(dir,'b','session.jsonl');writeFileSync(a,'{}');writeFileSync(b,'{}');
  assert.notEqual(parseArguments([a]).state,parseArguments([b]).state);
});
test('network errors do not expose server response bodies or credentials', async()=>{
  const client={systemOne:async()=>{throw new Error('secret-private-transcript');}};
  await assert.rejects(runPass1(client,{score:()=>({}),choice:()=>({})},[prose('short')],opts,{input:0,output:0,requests:0}),error=>!error.message.includes('secret-private-transcript'));
});
test('offline, precompact and plan cannot be bypassed using self-test', () => {
  for(const flag of ['--offline','--precompact','--plan','--update','--digest']) {
    assert.throws(()=>parseArguments([flag,'--self-test']),/cannot be combined/);
    assert.throws(()=>parseArguments(['--self-test',flag]),/cannot be combined/);
  }
});
test('UTF-8 byte budget splits batches and retains oversize singleton entries', async()=>{
  const requests=[], records=[prose('界'.repeat(6000),0),prose('界'.repeat(6000),1),prose('界'.repeat(12000),2)];
  const client={systemOne:async request=>{requests.push(request);return {answers:{}};}};
  await runPass1(client,{score:()=>({}),choice:()=>({})},records,{...opts,chars:16000,batch:2},{input:0,output:0,requests:0});
  assert.equal(requests.length,2);
  assert.ok(requests.every(request=>Buffer.byteLength(JSON.stringify(request))<=30000));
  assert.ok(records.every(r=>!r.retention));
});
test('offline updates count zero freshly scored entries',t=>{
  const input=join(temporary(t),'input');writeFileSync(input,JSON.stringify(prose('A durable decision').entry));
  const result=spawnSync(process.execPath,['src/filter-transcript.mjs',input,'--offline','--update','--keep-tail','0'],{encoding:'utf8'});
  assert.equal(result.status,0);assert.match(result.stderr,/\+0 scored/);assert.match(result.stderr,/analyzed/);
});
test('steering selects the latest summary and gives later corrections precedence',()=>{
  const records=[{...prose('old',1),category:CATEGORY.COMPACT_SUMMARY},{...prose('new',8),category:CATEGORY.COMPACT_SUMMARY}];
  const text=precompactInstructions(records);assert.match(text,/latest compaction summary at entry 8/);assert.match(text,/Later user instructions and explicit corrections take precedence/);
});
