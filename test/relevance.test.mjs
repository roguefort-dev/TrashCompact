import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecords, protectRecords, dedupPayloads, runPolicies } from '../src/filter-transcript.mjs';
import { prepareRelevance, segmentProse, buildRelevanceQuestions, judgeRelevance, selectRelevance, renderRelevance } from '../src/relevance.mjs';

const user = (text,index) => ({index,role:'user',category:'human_instruction',text});
const assistant = (text,index=2,extra={}) => ({index,role:'assistant',category:'prose',text,...extra});
const requests = () => [user('Describe the cache data model and its stable identifiers.',0),user('Document the existing API contract.',1)];
const sdk = {noul:(instructions,criteria)=>({type:'noul',instructions,criteria})};
const judged = (relevance,dependency=0,bugfix=0) => ({systemOne:async({questions})=>({answers:Object.fromEntries(Object.keys(questions).map(id=>[id,{type:'noul',noul:id.endsWith('_dependency')?dependency:id.endsWith('_bugfix')?bugfix:relevance}]))})});

test('benchmark is exactly the last two human requests, excluding complete app continuations',()=>{
  const records=[user('Old unrelated task',0),...requests(),user('<environment_context>machine details</environment_context>',3),
    user('<codex_internal_context source="goal"><objective>autoplay</objective>budget</codex_internal_context>',4),assistant('Candidate',5)];
  const prepared=prepareRelevance(records);
  assert.deepEqual(prepared.benchmark,requests().map(({index,text})=>({entry:index,text})));
  assert.equal(prepared.usable,true);
  const partial=prepareRelevance([...requests(),user('<environment_context>incomplete',3)]);
  assert.equal(partial.benchmark.at(-1).text,'<environment_context>incomplete');
});

test('ambiguous, missing, unsafe, and oversized benchmarks disable removal without truncation',()=>{
  for(const records of [[user('ok',0),user('ok next!',1)], [user('Continue',0)],
    [user('First request',0),user('password=synthetic-sensitive-value',1)]]) {
    assert.equal(prepareRelevance([...records,assistant('Irrelevant text',3)]).usable,false);
  }
  const prepared=prepareRelevance([...requests(),assistant('Other text')],{benchmarkBytes:20});
  assert.equal(prepared.reason,'benchmark-over-budget');
  assert.equal(prepared.benchmark[0].text,requests()[0].text);
  assert.equal(prepared.candidates.length,0);
});

test('standalone AGENTS app envelopes do not become requests but user additions remain',()=>{
  const envelope='# AGENTS.md instructions for /synthetic/project\n\n<INSTRUCTIONS>Use the documented style.</INSTRUCTIONS>';
  const records=[...requests(),user(envelope+'\n<environment_context>machine info</environment_context>',3),assistant('A standalone observation.',4)];
  const prepared=prepareRelevance(records);
  assert.deepEqual(prepared.benchmark,requests().map(({index,text})=>({entry:index,text})));
  assert.equal(prepared.candidates[0].sourceRequest,requests()[1].text);
  for(const text of [envelope+'\nPlease revise these instructions.', '# AGENTS.md instructions\n<INSTRUCTIONS>Incomplete']) {
    assert.equal(prepareRelevance([...requests(),user(text,3)]).benchmark.at(-1).text,text);
  }
});

test('complete browser request envelopes do not make acknowledgments substantive',()=>{
  const wrapped=text=>`<in-app-browser-context>Opened /synthetic/page</in-app-browser-context>\n\n## My request:\n${text}`;
  const prepared=prepareRelevance([user(wrapped('ok'),0),user(wrapped('thanks'),1),assistant('Other text')]);
  assert.equal(prepared.reason,'ambiguous-benchmark');
  assert.deepEqual(prepared.benchmark.map(item=>item.text),['ok','thanks']);
  const substantive=prepareRelevance([user(wrapped('Describe the cache API.'),0),user(wrapped('Include field types.'),1),assistant('Other text')]);
  assert.equal(substantive.usable,true);
  assert.equal(substantive.candidates[0].sourceRequest,'Include field types.');
  const partial='<in-app-browser-context>incomplete\n## My request:\nok';
  assert.equal(prepareRelevance([...requests(),user(partial,3)]).benchmark.at(-1).text,partial);
});

test('paragraph spans preserve UTF-8, paths, decimals, lists, and adjacent qualifications',()=>{
  const text='Measured café latency at 1.25 ms. Read /tmp/cache.v2.json before changing it.\n\nHowever, that measurement excludes cold starts.\n- Keep stable IDs.\n- Preserve API clients.\n';
  const spans=segmentProse(text),bytes=Buffer.from(text);
  assert.equal(spans.length,2);
  assert.equal(spans.map(span=>span.text).join(''),text);
  for(const span of spans) assert.equal(bytes.subarray(span.start,span.end).toString('utf8'),span.text);
  const prepared=prepareRelevance([...requests(),assistant(text)]);
  assert.equal(prepared.candidates[0].after,spans[1].text);
  assert.equal(prepared.candidates[1].before,spans[0].text);
  const request=buildRelevanceQuestions(sdk,prepared);
  assert.match(request.questions.p0_dependency.instructions,/items\.p0\.after/);
  assert.equal(request.state.items.p0.passage.text,spans[0].text);
});

test('v2 dependency veto preserves relevant qualifications despite low topical relevance',async()=>{
  const records=[...requests(),assistant('The selected configuration is suitable.\n\nHowever, only after refreshing the existing cache.')];
  const prepared=prepareRelevance(records,{variant:'v2'});
  await judgeRelevance(judged(0,0.9),sdk,prepared);
  assert.ok(selectRelevance(prepared).every(item=>item.keep));
  assert.equal(renderRelevance(records,prepared).at(-1).text,records.at(-1).text);
  const baseline=prepareRelevance(records,{variant:'v1'});
  await judgeRelevance(judged(0),sdk,baseline);
  assert.ok(selectRelevance(baseline).every(item=>!item.keep));
});

test('only deterministic survivors that are unprotected plain assistant prose qualify',()=>{
  const records=[...requests(),assistant('plain'),assistant('gone',3,{removed:'exact-repeat'}),assistant('recent',4,{protected:true}),
    assistant('unknown',5,{pinned:true}),assistant('thinking',6,{category:'thinking'}),assistant('tool',7,{role:'tool',category:'tool_output'}),
    assistant('Code: `return 1`',8),assistant('```js\nreturn 1;\n```',9),assistant('secret=synthetic-private-value',10),assistant('ciphertext opaque',11)];
  assert.deepEqual(prepareRelevance(records).candidates.map(item=>item.entry),[2]);
});

test('missing, invalid, wrong-type, and failed judgments keep every passage',async()=>{
  for(const answers of [{}, {p0_relevance:{type:'noul',noul:0}},
    {p0_relevance:{type:'noul',noul:-1},p0_dependency:{type:'noul',noul:0}},
    {p0_relevance:{type:'score',noul:0},p0_dependency:{type:'noul',noul:0}},
    {p0_relevance:{type:'noul',noul:0},p0_dependency:{type:'noul',noul:NaN}}]) {
    const prepared=prepareRelevance([...requests(),assistant('Other text')]);
    await judgeRelevance({systemOne:async()=>({answers:{p0_bugfix:{type:'noul',noul:0},...answers}})},sdk,prepared);
    assert.equal(selectRelevance(prepared)[0].keep,true);
  }
  const prepared=prepareRelevance([...requests(),assistant('Other text')]);
  const usage={};await judgeRelevance({systemOne:async()=>{throw Error('Synthetic failure');}},sdk,prepared,usage);
  assert.equal(selectRelevance(prepared)[0].keep,true);assert.equal(usage.failed,1);assert.equal(usage.unscored,1);
});

test('both variants protect explicit bug history and send task context to the semantic bugfix veto',async()=>{
  for(const variant of ['v1','v2']) {
    for(const text of ['The bug was fixed last week.', 'Root cause: the value was overwritten.', 'Regression totals: 79 tests passed.', 'The required fix preserves previous values.']) {
      const records=[...requests(),assistant(text)];
      const prepared=prepareRelevance(records,{variant});
      assert.equal(prepared.candidates.length,0);
      assert.equal(prepared.excluded.bugfix,1);
      assert.equal(renderRelevance(records,prepared).at(-1).text,text);
    }
    const records=[user('Fix the map regression.',0),assistant('The map now retains its previous value.',1),
      user('<codex_internal_context source="goal">Continue automatically</codex_internal_context>',2),assistant('All requested checks pass.',3),
      user('Choose colors for a new page.',4),user('Make that page readable on mobile.',5),assistant('A blue background would be appropriate.',6)];
    const prepared=prepareRelevance(records,{variant});
    assert.deepEqual(prepared.candidates.map(item=>item.entry),[1,3,6]);
    assert.equal(prepared.candidates[0].sourceRequest,'Fix the map regression.');
    await judgeRelevance(judged(0,0,0.95),sdk,prepared);
    assert.ok(selectRelevance(prepared).every(item=>item.keep));
  }
});

test('independent bugfix veto preserves implicit historical corrections and missing answers keep',async()=>{
  for(const variant of ['v1','v2']) {
    const records=[...requests(),assistant('A zero value now retains its previous state.')];
    const prepared=prepareRelevance(records,{variant});
    await judgeRelevance(judged(0,0,0.9),sdk,prepared);
    assert.equal(selectRelevance(prepared)[0].keep,true);
    const request=buildRelevanceQuestions(sdk,prepared);
    assert.match(request.questions.p0_bugfix.instructions,/historical|completed/i);
    assert.equal(request.state.items.p0.sourceRequest,requests()[1].text);
    const missing=prepareRelevance(records,{variant});
    await judgeRelevance({systemOne:async()=>({answers:{p0_relevance:{type:'noul',noul:0},p0_dependency:{type:'noul',noul:0}}})},sdk,missing);
    assert.equal(selectRelevance(missing)[0].keep,true);
  }
});

test('explicit source request context protects earlier work and invalidates cached judgments',async()=>{
  const records=[...requests(),assistant('The map now retains its previous value.')];
  const prepared=prepareRelevance(records,{sourceRequests:{2:'Document this data structure.'}});
  const cache=await judgeRelevance(judged(0,0,0),sdk,prepared);
  const changed=prepareRelevance(records,{sourceRequests:{2:'Explain the object lifecycle.'}},cache);
  assert.equal(changed.candidates[0].verdict,null);
  const guarded=prepareRelevance(records,{sourceRequests:{2:'Fix the cache regression.'}},cache);
  assert.equal(guarded.candidates.length,1);
  assert.equal(guarded.candidates[0].verdict,null);
  await judgeRelevance(judged(0,0,0.95),sdk,guarded);
  assert.equal(selectRelevance(guarded)[0].keep,true);
  for(const value of [null,undefined,'',' \t\n']) {
    const unknown=prepareRelevance(records,{sourceRequests:{2:value}},cache);
    assert.equal(unknown.candidates.length,0);
    assert.equal(unknown.excluded.missingSourceContext,1);
  }
});

test('rendering revalidates roles, protection, category, benchmark and explicit source context',async()=>{
  const records=[...requests(),assistant('Unrelated weather note.')];
  const prepared=prepareRelevance(records);
  await judgeRelevance(judged(0,0,0),sdk,prepared);
  assert.equal(selectRelevance(prepared)[0].keep,false);
  for(const changes of [{role:'user'},{protected:true},{pinned:true},{category:'thinking'}]) {
    const changed=[...records.slice(0,-1),{...records.at(-1),...changes}];
    assert.equal(renderRelevance(changed,prepared).at(-1).text,records.at(-1).text);
  }
  const newBenchmark=[user('Describe the weather today.',0),...records.slice(1)];
  assert.equal(renderRelevance(newBenchmark,prepared).at(-1).text,records.at(-1).text);
  const options={sourceRequests:{2:'Describe the data model.'}};
  const overridden=prepareRelevance(records,options);
  await judgeRelevance(judged(0,0,0),sdk,overridden);
  options.sourceRequests[2]='Fix the historical regression.';
  assert.equal(renderRelevance(records,overridden).at(-1).text,records.at(-1).text);
});

test('deterministic cleanup precedes model questions and bugfix context remains intact',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'tc-relevance-chain-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const input=join(directory,'input.jsonl');
  const message=(role,text)=>({type:'response_item',payload:{type:'message',role,content:[{type:'text',text}]}});
  const entries=[...requests().map(record=>message('user',record.text)),
    message('assistant','I will inspect the documentation next.'),message('assistant','I will inspect the documentation next.'),
    {type:'response_item',payload:{type:'function_call',call_id:'noop',name:'exec_command',arguments:'{"cmd":"true"}'}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'noop',output:JSON.stringify({exit_code:0,output:''})}},
    message('assistant','The historical bug was fixed by preserving previous values.'),
    message('assistant','An unrelated weather observation.'),
    ...Array.from({length:5},(_,index)=>message('assistant',`Recent protected context ${index}.`))];
  const raw=entries.map(JSON.stringify).join('\n');writeFileSync(input,raw);
  const {records}=loadRecords(input);protectRecords(records,5);dedupPayloads(records);runPolicies(records);
  assert.equal(records[2].removed,'exact-repeat');
  assert.equal(records[4].removed,'empty-noop-exchange');assert.equal(records[5].removed,'empty-noop-exchange');
  const snapshot=structuredClone(records),prepared=prepareRelevance(records);
  const seen=[];
  await judgeRelevance({systemOne:async request=>{
    const items=Object.values(request.state.items);seen.push(...items);
    assert.ok(items.every(item=>![2,4,5,6].includes(item.entry)));
    assert.ok(items.every(item=>!item.passage.text.includes('historical bug')));
    return judged(0,0,0).systemOne(request);
  }},sdk,prepared);
  assert.deepEqual(seen.map(item=>item.entry),[3,7]);
  assert.equal(seen.filter(item=>item.passage.text==='I will inspect the documentation next.').length,1);
  assert.equal(renderRelevance(records,prepared).find(record=>record.entry===6).text,entries[6].payload.content[0].text);
  assert.deepEqual(records,snapshot);assert.equal(readFileSync(input,'utf8'),raw);
});

test('selection has a strict low-relevance threshold and rendering copies source unchanged',async()=>{
  const records=[...requests(),assistant('Unrelated weather observation.\n\nPreserve the cache contract.')],original=structuredClone(records);
  const prepared=prepareRelevance(records);
  await judgeRelevance({systemOne:async()=>({answers:{p0_relevance:{type:'noul',noul:0.05},p0_dependency:{type:'noul',noul:0.05},p0_bugfix:{type:'noul',noul:0},p1_bugfix:{type:'noul',noul:0},p1_relevance:{type:'noul',noul:0.051},p1_dependency:{type:'noul',noul:0}}})},sdk,prepared);
  assert.deepEqual(selectRelevance(prepared).map(item=>item.keep),[false,true]);
  assert.equal(renderRelevance(records,prepared).at(-1).text,'[relevance omission]\nPreserve the cache contract.');
  assert.deepEqual(records,original);
  const changed=[...records.slice(0,-1),assistant('Changed source text')];
  assert.equal(renderRelevance(changed,prepared).at(-1).text,'Changed source text');
});

test('cache includes complete benchmark, model, prompt variant, source and neighbors without raw text',async()=>{
  const records=[...requests(),assistant('First source.\n\nNeighbor.')],options={model:'synthetic-model',variant:'v2'};
  const prepared=prepareRelevance(records,options),cache=await judgeRelevance(judged(0,0),sdk,prepared);
  assert.ok(prepareRelevance(records,options,cache).candidates.every(item=>item.verdict));
  for(const [changed,opts] of [[records,{...options,model:'other'}],[records,{...options,variant:'v1'}],
    [[user('Different initial request',0),...records.slice(1)],options],[[...requests(),assistant('First source.\n\nChanged neighbor.')],options]]) {
    assert.ok(prepareRelevance(changed,opts,cache).candidates.every(item=>!item.verdict));
  }
  assert.ok(!JSON.stringify(cache).includes('First source'));
  assert.ok(!JSON.stringify(cache).includes('cache invalidation'));
});

test('candidate sampling and request budgets keep unscored or unselected text',async()=>{
  const records=[...requests(),...Array.from({length:10},(_,i)=>assistant(`Observation ${i}`,i+2))];
  const prepared=prepareRelevance(records,{maxCandidates:3,requestBytes:1});
  assert.deepEqual(prepared.candidates.map(item=>item.entry),[2,7,11]);
  assert.equal(prepared.unselected,7);
  const usage={};await judgeRelevance({systemOne:async()=>assert.fail('Oversized requests must not be sent')},sdk,prepared,usage);
  assert.equal(usage.overBudget,3);assert.equal(usage.unscored,3);
  assert.deepEqual(renderRelevance(records,prepared).map(item=>item.text),records.map(item=>item.text));
});
