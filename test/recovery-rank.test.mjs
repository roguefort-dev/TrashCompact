import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareRecoveryRanking, scoreRecoveryRanking, rankedPassages, exactSpans, RANK_LIMITS } from '../src/recovery-rank.mjs';
import { classifyCodex, recoveryEvidence } from '../src/codex.mjs';
import { saveState, loadState } from '../src/filter-transcript.mjs';
const msg = (role, text, extra = {}) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra } });
const tool = text => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'x', output: text } });
const records = entries => {
  const result=entries.map((entry,index) => ({ entry, index, ...classifyCodex(entry) }));
  if(entries.some(entry=>entry.payload?.call_id==='x')) {
    const entry={type:'response_item',payload:{type:'function_call',call_id:'x',name:'exec_command',arguments:JSON.stringify({cmd:'verify-cache',workdir:'/synthetic/project'})}};
    result.push({entry,index:-1,...classifyCodex(entry)});
  }
  return result;
};
const opts = { model: 'test-model' };
const sdk = { score: () => ({ kind: 'score' }), choice: () => ({ kind: 'choice' }) };
const usage = () => ({ requests: 0, input: 0, output: 0 });
const client = (requests, relation = 'uncertain', confidence = 1) => ({ systemOne: async request => {
  requests.push(request);
  return { answers: Object.fromEntries(Object.entries(request.questions).map(([id,q]) => [id, q.kind === 'score' ? { score: 2, confidence: 1 } : { choice: relation, confidence }])), usage: { input_tokens: 10 } };
} });
function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'recovery-rank-')); t.after(() => rmSync(dir, { recursive:true,force:true })); return dir; }

test('candidate coverage includes long middle and exact Unicode UTF8 spans within fixed bounds', () => {
  const text = ['leading evidence '.repeat(25), 'middle diagnosis café🙂 cache invalidation defect', 'trailing evidence '.repeat(25)].join('\n');
  const data = records([msg('user','Fix the cache'), msg('assistant',text), tool(text)]);
  const prepared = prepareRecoveryRanking(data, opts);
  assert.ok(prepared.candidates.some(item => item.text.includes('middle diagnosis')));
  for (const item of prepared.candidates) {
    const source = item.role === 'tool' ? data[item.entry].entry.payload.output : data[item.entry].text;
    assert.equal(Buffer.from(source).subarray(item.start,item.end).toString('utf8'), item.text);
    assert.ok(Buffer.byteLength(item.text) <= RANK_LIMITS.passageBytes);
    assert.ok(!item.text.includes('\uFFFD'));
  }
  const lots = prepareRecoveryRanking(records(Array.from({length:100},()=>tool(text.repeat(10)))), opts);
  assert.ok(lots.candidates.length <= 96); assert.ok(lots.pairs.length <= 24);
});

test('expanded egress excludes engine, hidden, routed, mixed unknown, credentials and opaque payloads', async () => {
  const data = records([msg('user','Current request'), msg('system','ENGINE'),msg('assistant','HIDDEN',{phase:'analysis'}),
    msg('assistant','ROUTED',{recipient:'tool'}),msg('assistant','MIXED',{content:[{type:'output_text',text:'MIXED'},{type:'image',url:'x'}]}),
    tool('api_key=syntheticcredential'),tool('data:image/png;base64,'+'A'.repeat(300)),tool('encrypted_content: opaque'),
    {type:'response_item',payload:{type:'function_call_output',call_id:'x',output:[{type:'text',text:'BLOCK'},{type:'image',url:'unknown'}]}},tool('visible actual diagnostic')]);
  const prepared = prepareRecoveryRanking(data, opts), requests=[];
  await scoreRecoveryRanking(client(requests),sdk,prepared,usage());
  const sent=JSON.stringify(requests);
  for(const text of ['ENGINE','HIDDEN','ROUTED','MIXED','syntheticcredential','base64','encrypted_content','BLOCK']) assert.ok(!sent.includes(text));
  assert.ok(sent.includes('visible actual diagnostic'));
});

test('cache keys track model, query, complete source and exact span; unchanged append reuses judgments', async () => {
  const data=records([msg('user','Inspect cache defect'),tool('Cache invalidation remains broken.')]);
  const requests=[], first=prepareRecoveryRanking(data,opts);
  const cache=await scoreRecoveryRanking(client(requests),sdk,first,usage());
  const again=prepareRecoveryRanking([...data,...records([tool('New unrelated diagnostics.')]).map(r=>({...r,index:r.index+2}))],opts,cache);
  assert.ok(again.candidates.find(c=>c.entry===1).verdict);
  const unchanged=prepareRecoveryRanking(data,opts,cache); requests.length=0;
  await scoreRecoveryRanking(client(requests),sdk,unchanged,usage(),cache); assert.equal(requests.length,0);
  assert.ok(prepareRecoveryRanking([...data,...records([msg('user','Different user query')])],opts,cache).candidates.every(c=>!c.verdict));
  assert.ok(prepareRecoveryRanking(data,{model:'changed'},cache).candidates.every(c=>!c.verdict));
  assert.ok(prepareRecoveryRanking(records([msg('user','Inspect cache defect'),tool('Cache invalidation remains broken. Changed.')]),opts,cache).candidates.every(c=>!c.verdict));
});

test('uncertain and unrelated pairs retain both passages; generic success or plans cannot supersede', async () => {
  const data=records([msg('user','Investigate cache invalidation'),tool('Cache invalidation remains broken.'),tool('Cache invalidation fixed with canonical keys.')]);
  for(const [relation,confidence] of [['uncertain',1],['unrelated',1],['coexists',1],['supersedes',0.5]]) {
    const prepared=prepareRecoveryRanking(data,opts); assert.ok(prepared.pairs.length);
    await scoreRecoveryRanking(client([],relation,confidence),sdk,prepared,usage());
    const output=recoveryEvidence(data,6000,rankedPassages(prepared));
    assert.ok(output.includes('remains broken')); assert.ok(output.includes('fixed with canonical'));
  }
  for(const text of ['Cache invalidation: 20 tests passed.','We will fix cache invalidation.','Cache invalidation should be fixed next.'])
    assert.equal(prepareRecoveryRanking(records([tool('Cache invalidation remains broken.'),tool(text)]),opts).pairs.length,0);
});

test('suppression requires newer exact passage actually rendered and preserves independent old claim', async () => {
  const data=records([msg('user','Investigate cache invalidation'),tool('Cache invalidation remains broken.\nIndependent retention requirement remains: preserve byte offsets.'),tool('Cache invalidation fixed with canonical keys.')]);
  const prepared=prepareRecoveryRanking(data,opts); await scoreRecoveryRanking(client([],'supersedes'),sdk,prepared,usage());
  const ranking=rankedPassages(prepared), output=recoveryEvidence(data,6000,ranking);
  assert.ok(output.includes('fixed with canonical')); assert.ok(!output.includes('remains broken')); assert.ok(output.includes('Independent retention'));
  const newer=ranking.passages.find(c=>c.entry===2); newer.text='x'.repeat(7000);
  const noRoom=recoveryEvidence(data,6000,ranking);
  assert.ok(noRoom.includes('remains broken'));
});

test('ranked rendering protects user constraints and current final within six KB', async () => {
  const data=records([msg('user','<INSTRUCTIONS>Never suspend. Codex target only. No webpage.</INSTRUCTIONS>'),
    ...Array.from({length:20},(_,i)=>tool(`Evidence item ${i}: `+'useful cache observations '.repeat(40))),
    msg('user','Continue the Codex integration'),msg('assistant','Current final status: implementation complete; verification pending.',{phase:'final_answer'})]);
  const prepared=prepareRecoveryRanking(data,opts); await scoreRecoveryRanking(client([]),sdk,prepared,usage());
  const output=recoveryEvidence(data,6000,rankedPassages(prepared));
  assert.ok(Buffer.byteLength(output)<=6000);
  for(const text of ['Never suspend','Codex target only','No webpage','Continue the Codex integration','verification pending']) assert.ok(output.includes(text));
});

test('atomic cache merge retains independent passage, relation and prose namespaces', t => {
  const path=join(temp(t),'state.json');
  saveState(path,{version:2,verdicts:{first:{a:1}},recoveryRank:{version:1,passages:{a:{score:1,confidence:1}},relations:{r:{choice:'uncertain',confidence:1}}}});
  saveState(path,{version:2,verdicts:{second:{a:2}},recoveryRank:{version:1,passages:{b:{score:2,confidence:1}},relations:{}}});
  const saved=loadState(path); assert.deepEqual(Object.keys(saved.verdicts),['first','second']);
  assert.deepEqual(Object.keys(saved.recoveryRank.passages),['a','b']); assert.ok(saved.recoveryRank.relations.r);
});

test('CLI defaults never expand egress; opt-in update caches; offline recovery and plan make zero SDK calls', t => {
  const dir=temp(t), root=resolve(import.meta.dirname,'..'); cpSync(join(root,'src'),join(dir,'src'),{recursive:true});
  const pkg=join(dir,'node_modules/@typesafe-ai/sdk'); mkdirSync(pkg,{recursive:true});
  writeFileSync(join(pkg,'package.json'),JSON.stringify({type:'module',exports:'./index.mjs'}));
  const audit=join(dir,'sdk-audit');
  writeFileSync(join(pkg,'index.mjs'),`import {appendFileSync} from 'node:fs'; export const score=()=>({kind:'score'}); export const choice=()=>({kind:'choice'}); export class TypeSafeClient { async systemOne(request) {appendFileSync(${JSON.stringify(audit)},JSON.stringify(request)+'\\n');return {answers:Object.fromEntries(Object.entries(request.questions).map(([id,q])=>[id,q.kind==='score'?{score:2,confidence:1}:{choice:'uncertain',confidence:1}]))};}}`);
  const input=join(dir,'rollout.jsonl'), state=join(dir,'state.json');
  writeFileSync(input,[msg('user','Inspect cache'),tool('Cache invalidation diagnosis remains unresolved.')].map(JSON.stringify).join('\n')+'\n');
  const run=(...args)=>{const r=spawnSync(process.execPath,[join(dir,'src/filter-transcript.mjs'),input,'--state',state,...args],{encoding:'utf8',env:{...process.env,HOME:dir,CODEX_HOME:join(dir,'.codex'),TYPESAFE_API_KEY:'synthetic'}});assert.equal(r.status,0,r.stderr);return r;};
  run('--update'); assert.ok(!existsSync(audit));
  for(const mode of ['--recovery','--offline','--plan']) run(mode,'--recovery-rank'); assert.ok(!existsSync(audit));
  run('--update','--recovery-rank'); const first=readFileSync(audit,'utf8'); assert.ok(first.includes('Cache invalidation diagnosis'));
  run('--update','--recovery-rank'); assert.equal(readFileSync(audit,'utf8'),first);
  for(const mode of ['--recovery','--offline','--plan']) run(mode,'--recovery-rank'); assert.equal(readFileSync(audit,'utf8'),first);
  appendFileSync(input,JSON.stringify(msg('user','A new request'))+'\n'); run('--recovery','--recovery-rank'); assert.equal(readFileSync(audit,'utf8'),first);
});
test('source shortlist reserves assistant passages when newer tool output floods the tail', () => {
  const data=records([msg('assistant','Critical diagnosis in the assistant record.'),...Array.from({length:60},(_,i)=>tool(`Routine terminal ${i} output.`))]);
  const prepared=prepareRecoveryRanking(data,opts);
  assert.ok(prepared.candidates.some(item=>item.role==='assistant' && item.text.includes('Critical diagnosis')));
});

test('serialized request limits split escaped input batches and skip oversized singleton questions', async () => {
  const data=records([msg('user','\u0001'.repeat(1200)),...Array.from({length:16},()=>tool('\u0001'.repeat(640)))]);
  const prepared=prepareRecoveryRanking(data,opts),requests=[];
  const realistic={score:(prompt,levels)=>({kind:'score',prompt,levels}),choice:(prompt,levels)=>({kind:'choice',prompt,levels})};
  await scoreRecoveryRanking(client(requests),realistic,prepared,usage());
  assert.ok(requests.length>2);
  for(const request of requests) assert.ok(Buffer.byteLength(JSON.stringify(request))<=30000);
  const oversized={score:()=>({padding:'x'.repeat(31000)}),choice:()=>({padding:'x'.repeat(31000)})};
  const skipped=[]; await scoreRecoveryRanking(client(skipped),oversized,prepareRecoveryRanking(records([tool('Specific evidence')]),opts),usage());
  assert.equal(skipped.length,0);
});
test('an exact newer claim rendered in the protected final can supersede only its older passage', async () => {
  const data=records([msg('user','Investigate cache invalidation'),tool('Cache invalidation remains broken.\nIndependent retention requirement remains: preserve byte offsets.'),msg('assistant','Cache invalidation fixed with canonical keys.',{phase:'final_answer'})]);
  const prepared=prepareRecoveryRanking(data,opts); await scoreRecoveryRanking(client([],'supersedes'),sdk,prepared,usage());
  const output=recoveryEvidence(data,6000,rankedPassages(prepared));
  assert.ok(output.includes('fixed with canonical')); assert.ok(!output.includes('remains broken')); assert.ok(output.includes('Independent retention'));
});
test('known tool envelope id and internal metadata permit only output to reach ranking', async () => {
  const entry=tool('Actual diagnostic tool evidence.');
  entry.payload.id='INTERNAL_ID'; entry.payload.internal_chat_message_metadata_passthrough={private:'INTERNAL_METADATA'};
  const requests=[], prepared=prepareRecoveryRanking(records([entry]),opts);
  assert.equal(prepared.candidates.length,1);
  await scoreRecoveryRanking(client(requests),sdk,prepared,usage());
  const sent=JSON.stringify(requests); assert.ok(sent.includes('Actual diagnostic'));
  assert.ok(!sent.includes('INTERNAL_ID')); assert.ok(!sent.includes('INTERNAL_METADATA'));
});

test('ranked rendering reserves two earlier final states and omits records removed after candidate scoring', async () => {
  const data=records([msg('user','Continue cache work'),msg('assistant','Prior final: parsing checks passed.',{phase:'final_answer'}),
    msg('assistant','Second final: canonical identity implemented.',{phase:'final_answer'}),
    ...Array.from({length:10},(_,i)=>tool(`Long diagnostic ${i}: `+'cache evidence observations '.repeat(35))),
    msg('assistant','Current final: integration pending.',{phase:'final_answer'})]);
  const prepared=prepareRecoveryRanking(data,opts); await scoreRecoveryRanking(client([]),sdk,prepared,usage());
  data[3].removed='noise';
  const output=recoveryEvidence(data,6000,rankedPassages(prepared));
  for(const text of ['parsing checks passed','canonical identity implemented','integration pending']) assert.ok(output.includes(text));
  assert.ok(!output.includes('Long diagnostic 0:'));
});

test('pending rank whose selected span cannot fit still permits a smaller baseline excerpt', () => {
  const data=records([msg('user','Inspect outputs'),tool('Small baseline diagnostic survives.')]);
  const passage={key:'large',entry:1,role:'tool',kind:'tool_output',field:'output',start:0,end:7000,text:'x'.repeat(7000)};
  const output=recoveryEvidence(data,6000,{passages:[passage],relations:[]});
  assert.ok(output.includes('Small baseline diagnostic survives'));
});
test('explicit completed configuration changes propose chronological pairs without asserting supersession', () => {
  for(const [older,newer] of [['Port is 4186.','Port changed to 4187.'],['Server running on localhost.','Server no longer running on localhost.'],['Revision abc is local only.','Revision abc pushed to main.'],['Clamp limits the preview width.','Clamp removed from preview width.']]) {
    const prepared=prepareRecoveryRanking(records([tool(older),tool(newer)]),opts);
    assert.equal(prepared.pairs.length,1,`${older} -> ${newer}`);
    assert.equal(prepared.pairs[0].verdict,null);
    assert.equal(rankedPassages(prepared).relations.length,0);
  }
  assert.equal(prepareRecoveryRanking(records([tool('Port is 4186.'),tool('We will change the port to 4187.')]),opts).pairs.length,0);
});
test('ranking preserves every user correction selected by the baseline note', async () => {
  const data=records([msg('user','Original request: build a Codex integration.'),msg('user','Never create a webpage.'),
    msg('assistant','Earlier completed state.',{phase:'final_answer'}),msg('user','Do not suspend the machine.'),
    ...Array.from({length:15},(_,i)=>tool(`Candidate ${i}: `+'diagnostic evidence cache '.repeat(35))),
    msg('user','Use the canonical transcript identity.'),msg('user','Continue with verification.'),msg('assistant','Current final status: tests pending.',{phase:'final_answer'})]);
  const baseline=recoveryEvidence(data), prepared=prepareRecoveryRanking(data,opts);
  await scoreRecoveryRanking(client([]),sdk,prepared,usage());
  const ranked=recoveryEvidence(data,6000,rankedPassages(prepared));
  const userLines=baseline.split('\n').flatMap(line=>{try{const item=JSON.parse(line);return item.role==='user'?[item]:[];}catch{return [];}});
  assert.ok(userLines.length>3);
  for(const item of userLines) assert.ok(ranked.includes(JSON.stringify(item.excerpt)),item.excerpt);
  assert.ok(Buffer.byteLength(ranked)<=6000);
});
test('protected mixed finals keep independent claims and annotate only visible high-confidence replacements', async () => {
  const data=records([msg('user','Inspect cache state'),msg('assistant','Cache invalidation remains broken.\nThe retention budget remains six KB.',{phase:'final_answer'}),
    msg('assistant','Cache invalidation fixed with canonical keys.',{phase:'final_answer'})]);
  for(const confidence of [1,0.5]) {
    const prepared=prepareRecoveryRanking(data,opts);await scoreRecoveryRanking(client([],'supersedes',confidence),sdk,prepared,usage());
    const output=recoveryEvidence(data,6000,rankedPassages(prepared));
    assert.ok(output.includes('retention budget remains six KB'));
    assert.equal(output.includes('passage_relation'),confidence===1);
    assert.ok(Buffer.byteLength(output)<=6000);
  }
});
test('pure known text blocks retain exact per-block UTF8 provenance while mixed blocks remain excluded', () => {
  const entry=tool('placeholder'); entry.payload.output=[{type:'input_text',text:'First café diagnostic.'},{type:'output_text',text:'Second 🙂 actual result.'}];
  const prepared=prepareRecoveryRanking(records([entry]),opts);
  assert.equal(prepared.candidates.length,2);
  for(const item of prepared.candidates) {
    const block=entry.payload.output[Number(item.field.split('.')[1])];
    assert.equal(Buffer.from(block.text).subarray(item.start,item.end).toString('utf8'),item.text);
  }
  entry.payload.output.push({type:'encrypted',data:'opaque'});
  assert.equal(prepareRecoveryRanking(records([entry]),opts).candidates.length,0);
});

test('full meaningful user source invalidates omitted middle changes and pure app envelopes do not become the query', async () => {
  const prefix='Opening task '.repeat(120),suffix=' End constraints'.repeat(120);
  const base=records([msg('user',prefix+' ALPHA constraint '+suffix),tool('Specific evidence.')]);
  const first=prepareRecoveryRanking(base,opts), cache=await scoreRecoveryRanking(client([]),sdk,first,usage());
  const changed=prepareRecoveryRanking(records([msg('user',prefix+' BETA constraint '+suffix),tool('Specific evidence.')]),opts,cache);
  assert.equal(changed.query,first.query); assert.ok(changed.candidates.every(item=>!item.verdict));
  const app=prepareRecoveryRanking([...base,...records([msg('user','<environment_context>runtime only</environment_context>')])],opts,cache);
  assert.equal(app.query,first.query); assert.ok(app.candidates.every(item=>item.verdict));
  assert.ok(Buffer.byteLength(first.query)<=1200);
});

test('tool command identity invalidates ranking and unknown or different scopes cannot imply supersession', () => {
  const old=tool('Cache invalidation remains broken.'),newer=tool('Cache invalidation fixed with canonical keys.');newer.payload.call_id='y';
  const call=(id,cmd)=>({type:'response_item',payload:{type:'function_call',call_id:id,name:'exec_command',arguments:JSON.stringify({cmd,workdir:'/synthetic/project'})}});
  const raw=[old,newer,call('x','verify-alpha'),call('y','verify-beta')];
  const data=raw.map((entry,index)=>({entry,index,...classifyCodex(entry)}));
  const different=prepareRecoveryRanking(data,opts);assert.equal(different.pairs.length,0);
  raw[3]=call('y','verify-alpha');
  const same=prepareRecoveryRanking(raw.map((entry,index)=>({entry,index,...classifyCodex(entry)})),opts);
  assert.equal(same.pairs.length,1); assert.notEqual(different.candidates.find(c=>c.entry===1).key,same.candidates.find(c=>c.entry===1).key);
  assert.equal(prepareRecoveryRanking(data.slice(0,2),opts).pairs.length,0);
});

test('valid mixed-adjacent score distributions can rank evidence without weakening supersession confidence', () => {
  const prepared=prepareRecoveryRanking(records([tool('Specific useful evidence.')]),opts);
  prepared.candidates[0].verdict={score:1.4,confidence:0.35};
  assert.equal(rankedPassages(prepared).passages.length,1);
  assert.equal(rankedPassages(prepared).relations.length,0);
});
test('same command in distinct or unknown directories cannot supersede tool evidence', () => {
  const make=cwd=>({type:'response_item',payload:{type:'function_call',call_id:cwd??'unknown',name:'exec_command',arguments:JSON.stringify({cmd:'npm test',...(cwd?{workdir:cwd}:{})})}});
  const output=(id,text)=>({type:'response_item',payload:{type:'function_call_output',call_id:id,output:text}});
  const data=[make('/project/a'),output('/project/a','Cache invalidation remains broken.'),make('/project/b'),output('/project/b','Cache invalidation fixed with canonical keys.')].map((entry,index)=>({entry,index,...classifyCodex(entry)}));
  const prepared=prepareRecoveryRanking(data,opts);assert.equal(prepared.pairs.length,0);
  assert.notEqual(prepared.candidates[0].commandKey,prepared.candidates[1].commandKey);
  const unknown=[make(),output('unknown','Cache invalidation fixed with canonical keys.')].map((entry,index)=>({entry,index:index+4,...classifyCodex(entry)}));
  assert.equal(prepareRecoveryRanking([...data,...unknown],opts).pairs.length,0);
  assert.equal(prepareRecoveryRanking(unknown,opts).candidates[0].commandKey,null);
});

test('ranking removes only known ambient browser envelopes before query egress and cache identity', async () => {
  const browser = label => `<in-app-browser-context source="ambient-ui-state">\n${label}\n</in-app-browser-context>\n`;
  const data = records([msg('user', browser('PRIVATE_TAB_A') + 'Check playback.'), msg('assistant', 'Playback fixed while stopped.')]);
  const prepared = prepareRecoveryRanking(data, opts), requests = [];
  const cache = await scoreRecoveryRanking(client(requests), sdk, prepared, usage());
  assert.equal(prepared.query, 'Check playback.');
  assert.ok(!JSON.stringify(requests).includes('PRIVATE_TAB_A'));
  const changed = records([msg('user', browser('PRIVATE_TAB_B') + 'Check playback.'), msg('assistant', 'Playback fixed while stopped.')]);
  assert.ok(prepareRecoveryRanking(changed, opts, cache).candidates.every(candidate => candidate.verdict));
  const unknown = prepareRecoveryRanking(records([msg('user', '<in-app-browser-context source="user">Keep this context.</in-app-browser-context>'), msg('assistant', 'Done.')]), opts);
  assert.match(unknown.query, /Keep this context/);
});

test('empty execution and session receipts are excluded before ranking without hiding failed output', async () => {
  const data = records([msg('user', 'Check playback.'),
    tool('Script completed\nWall time 0.1 seconds\nOutput:\n\n'),
    tool('Script completed\nWall time 0.1 seconds\nOutput:\nSESSION_ID=987654'),
    tool('Script completed\nWall time 0.1 seconds\nOutput:\nERROR: playback failed'),
  ]);
  const prepared = prepareRecoveryRanking(data, opts), requests = [];
  await scoreRecoveryRanking(client(requests), sdk, prepared, usage());
  assert.ok(!prepared.candidates.some(candidate => [1, 2].includes(candidate.entry)));
  assert.ok(prepared.candidates.some(candidate => candidate.text.includes('playback failed')));
  assert.ok(!JSON.stringify(requests).includes('SESSION_ID=987654'));
});
