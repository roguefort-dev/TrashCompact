import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTaskGroups, judgeTaskGroups, taskGroupsFor } from '../src/task-groups.mjs';
import { cleanedUserRequests, prepareRelevance, judgeRelevance, renderRelevance, selectRelevance } from '../src/relevance.mjs';
import { loadRecords, protectRecords, dedupPayloads, runPolicies } from '../src/filter-transcript.mjs';

const user=(text,index)=>({role:'user',category:'human_instruction',text,index});
const assistant=(text,index,extra={})=>({role:'assistant',category:'prose',text,index,...extra});
const users=texts=>texts.map(user);
const sdk={choice:(instructions,choices)=>({type:'choice',instructions,choices}),noul:(instructions,criteria)=>({type:'noul',instructions,criteria})};
const answer=(choice,probabilities,confidence=.8)=>({type:'choice',choice,confidence,probabilities});
const certain=choice=>answer(choice,Object.fromEntries(['continuation','steering','new_task','uncertain'].map(label=>[label,label===choice?.97:.01])));
async function grouped(records,labels,options={}) {
  let count=0;
  const prepared=prepareTaskGroups(records,options);
  const cache=await judgeTaskGroups({systemOne:async()=>({answers:{relation:typeof labels[count]==='string'?certain(labels[count++]):labels[count++]}})},sdk,prepared);
  return {prepared,groups:taskGroupsFor(prepared),cache,count};
}

test('task anchor plus continuation and acknowledgment form one complete benchmark',async()=>{
  const records=users(['Document the API.','continue plz','ok next!']),original=structuredClone(records);
  const {groups}=await grouped(records,['continuation','continuation']);
  assert.equal(groups.complete,true);assert.equal(groups.groups.length,1);
  assert.deepEqual(groups.groups[0].members,cleanedUserRequests(records));
  const relevance=prepareRelevance([...records,assistant('A procedural announcement.',3)],{taskGroups:groups});
  assert.equal(relevance.usable,true);assert.equal(relevance.benchmark.length,1);
  assert.equal(relevance.benchmark[0].text,'Document the API.\n\ncontinue plz\n\nok next!');
  assert.deepEqual(records,original);
});

test('join action sums continuation and steering probability despite low entropy confidence',async()=>{
  const records=users(['Document the API.','Include field types.']);
  const joined=await grouped(records,[answer('continuation',{continuation:.45,steering:.45,new_task:.05,uncertain:.05},.02)]);
  assert.equal(joined.groups.groups.length,1);assert.equal(joined.groups.groups[0].uncertain,false);
  assert.equal(joined.groups.decisions[1].action,'join');
  const uncertain=await grouped(records,[answer('new_task',{continuation:.1,steering:.3,new_task:.4,uncertain:.2},.9)]);
  assert.equal(uncertain.groups.groups[0].uncertain,true);
  assert.equal(prepareRelevance(records,{taskGroups:uncertain.groups}).usable,true);
});

test('steering stays with its anchor and independent objectives start new groups sequentially',async()=>{
  const records=users(['Document the API.','Use concise examples.','Design a new landing page.','Use large type.']);
  let calls=0,active=0;
  const prepared=prepareTaskGroups(records);
  await judgeTaskGroups({systemOne:async({state})=>{
    assert.equal(++active,1);
    const expected=calls<2?'Document the API.':'Design a new landing page.';
    assert.equal(state.activeTask.anchor.text,expected);
    if(calls===1) assert.deepEqual(state.activeTask.members.map(member=>member.text),[records[1].text]);
    await Promise.resolve();active--;
    return {answers:{relation:certain(['steering','new_task','steering'][calls++])}};
  }},sdk,prepared);
  assert.deepEqual(taskGroupsFor(prepared).groups.map(group=>group.members.map(member=>member.text)),[
    ['Document the API.','Use concise examples.'],['Design a new landing page.','Use large type.'],
  ]);
});

test('mixed, cancellation, and return-to-older requests remain explicit uncertain context',async()=>{
  for(const next of ['Continue the API and also book a trip.','Cancel that.','Return to the original API task.']) {
    const records=users(['Document the API.','Design a landing page.',next]);
    const {groups}=await grouped(records,['new_task','uncertain']);
    assert.equal(groups.groups.at(-1).uncertain,true);
    assert.deepEqual(groups.groups.flatMap(group=>group.members),cleanedUserRequests(records));
    const benchmark=prepareRelevance(records,{taskGroups:groups});
    assert.equal(benchmark.usable,true);
    assert.equal(benchmark.benchmark.map(item=>item.text).join('\n\n'),cleanedUserRequests(records).map(item=>item.text).join('\n\n'));
  }
});

test('failed or invalid boundaries preserve text and later clear tasks can recover trusted benchmarks',async()=>{
  for(const bad of [null,answer('continuation',{continuation:.9,steering:.9,new_task:.1,uncertain:.1}),
    answer('continuation',{continuation:NaN,steering:0,new_task:0,uncertain:0}),
    answer('continuation',{continuation:1})]) {
    const records=users(['Document the API.','Some ambiguous change.','Design a landing page.','Prepare a garden plan.']);
    const {groups}=await grouped(records,[bad,'new_task','new_task']);
    assert.equal(groups.groups[0].uncertain,true);
    assert.equal(groups.groups[1].uncertain,false);assert.equal(groups.groups[2].uncertain,false);
    assert.equal(prepareRelevance(records,{taskGroups:groups}).usable,true);
    assert.deepEqual(groups.groups.flatMap(group=>group.members),cleanedUserRequests(records));
  }
  const records=users(['Document the API.','Another request.']),prepared=prepareTaskGroups(records),usage={};
  await judgeTaskGroups({systemOne:async()=>{throw Error('Synthetic failure');}},sdk,prepared,usage);
  assert.equal(taskGroupsFor(prepared).groups[0].uncertain,true);assert.equal(usage.failed,1);
});

test('orphan continuations and exhausted budgets retain every unresolved request',async()=>{
  const orphan=await grouped(users(['continue plz']),[]);
  assert.equal(orphan.groups.groups[0].uncertain,true);
  assert.equal(prepareRelevance(users(['continue plz']),{taskGroups:orphan.groups}).usable,false);
  for(const options of [{maxRequests:1},{contextBytes:1},{requestBytes:1}]) {
    const records=users(['Document the API.','Include field types.']),prepared=prepareTaskGroups(records,options);
    await judgeTaskGroups({systemOne:async()=>assert.fail('Over-budget grouping must not call the model')},sdk,prepared);
    const groups=taskGroupsFor(prepared);
    assert.equal(groups.complete,false);
    assert.deepEqual([...groups.groups.flatMap(group=>group.members),...groups.unresolved],cleanedUserRequests(records));
    assert.equal(prepareRelevance(records,{taskGroups:groups}).usable,false);
  }
});

test('complete app wrappers are excluded while explicit skill requests and exact steering remain',async()=>{
  const records=[user('<skill>Expanded instructions.</skill>',0),user('$unslop',1),
    user('<codex_internal_context source="goal">continue automatically</codex_internal_context>',2),
    user('<in-app-browser-context>Page state</in-app-browser-context>\n## My request:\nUse concise language.',3),
    user('# AGENTS.md instructions\n<INSTRUCTIONS>Local rules.</INSTRUCTIONS>',4)];
  const {groups,count}=await grouped(records,['steering']);
  assert.equal(count,1);
  assert.deepEqual(groups.groups[0].members,[{entry:1,text:'$unslop'},{entry:3,text:'Use concise language.'}]);
  assert.equal(cleanedUserRequests([user('<skill>Incomplete',0)])[0].text,'<skill>Incomplete');
});

test('stale request bindings and altered boundaries cannot authorize relevance removal',async()=>{
  const records=[...users(['Document the API.','continue plz']),assistant('A procedural announcement.',2)];
  const {groups}=await grouped(records,['continuation']);
  for(const changed of [[user('Different objective.',0),...records.slice(1)], [...records,user('New constraint.',3)]]) {
    assert.equal(prepareRelevance(changed,{taskGroups:groups}).usable,false);
  }
  const tampered=structuredClone(groups);tampered.groups[0].members.reverse();
  assert.equal(prepareRelevance(records,{taskGroups:tampered}).usable,false);
  const prepared=prepareRelevance(records,{taskGroups:groups});
  await judgeRelevance({systemOne:async({questions})=>({answers:Object.fromEntries(Object.keys(questions).map(id=>[id,{type:'noul',noul:0}]))})},sdk,prepared);
  assert.match(renderRelevance(records,prepared).at(-1).text,/omission/);
  const changed=[user('A different objective.',0),...records.slice(1)];
  assert.equal(renderRelevance(changed,prepared).at(-1).text,records.at(-1).text);
});

test('group bindings revalidate assistant evidence and orphan uncertainty cannot be forged away',async()=>{
  const records=[user('Document the API.',0),assistant('Shall I add field descriptions?',1),user('Yes do that.',2),assistant('A procedural note.',3)];
  const {groups}=await grouped(records,['continuation']);
  assert.equal(prepareRelevance(records,{taskGroups:groups}).usable,true);
  for(const changes of [{text:'Shall I replace the entire interface?'},{pinned:true},{removed:'exact-repeat'},{role:'tool'},{category:'thinking'}]) {
    const changed=[records[0],{...records[1],...changes},...records.slice(2)];
    assert.equal(prepareRelevance(changed,{taskGroups:groups}).reason,'uncertain-or-stale-task-groups');
  }
  const orphanRecords=users(['continue plz']),orphan=await grouped(orphanRecords,[]);
  orphan.groups.decisions[0].reason=null;orphan.groups.groups[0].uncertain=false;
  assert.equal(prepareRelevance(orphanRecords,{taskGroups:orphan.groups}).usable,false);
});

test('long groups use bounded exact classifier context while retaining all members and benchmark limits',async()=>{
  const records=users(['Document the entire API.',...Array.from({length:30},(_,index)=>`Continue section ${index}. `+'Keep examples readable and concrete. '.repeat(14))]);
  const prepared=prepareTaskGroups(records,{contextBytes:3500});
  let calls=0,lastState;
  await judgeTaskGroups({systemOne:async({state})=>{
    calls++;lastState=state;
    assert.ok(state.activeTask.members.length<=4);
    assert.ok(state.activeTask.members.every(member=>member.entry!==state.activeTask.anchor.entry));
    assert.ok(Buffer.byteLength(JSON.stringify(state))<=3500);
    return {answers:{relation:certain('continuation')}};
  }},sdk,prepared);
  const groups=taskGroupsFor(prepared);
  assert.equal(calls,30);assert.equal(groups.complete,true);
  assert.ok(lastState.activeTask.omittedMemberCount>0);
  assert.deepEqual(groups.groups[0].members,cleanedUserRequests(records));
  const relevance=prepareRelevance(records,{taskGroups:groups,benchmarkBytes:12000});
  assert.equal(relevance.reason,'benchmark-over-budget');
  assert.equal(relevance.benchmark[0].text,cleanedUserRequests(records).map(record=>record.text).join('\n\n'));
  assert.deepEqual(relevance.benchmark[0].memberEntries,records.map(record=>record.index));
  assert.equal(relevance.benchmark[0].members,undefined);
});

test('prior anchors are bounded explicitly and appending requests reuses earlier sequential judgments',async()=>{
  const records=users(Array.from({length:9},(_,index)=>`Create independent deliverable ${index}.`));
  let finalState;
  const prepared=prepareTaskGroups(records);
  const cache=await judgeTaskGroups({systemOne:async({state})=>{finalState=state;return {answers:{relation:certain('new_task')}};}},sdk,prepared);
  assert.equal(finalState.earlierAnchors.length,4);assert.equal(finalState.omittedAnchorCount,3);
  const extended=[...records,user('Continue with the current deliverable.',9)];
  let calls=0;const usage={};
  await judgeTaskGroups({systemOne:async()=>{calls++;return {answers:{relation:certain('continuation')}};}},sdk,prepareTaskGroups(extended,{},cache),usage);
  assert.equal(calls,1);assert.equal(usage.cached,8);
  const modified=[user('An amended initial objective.',0),...records.slice(1)];
  let changedCalls=0;
  await judgeTaskGroups({systemOne:async()=>{changedCalls++;return {answers:{relation:certain('new_task')}};}},sdk,prepareTaskGroups(modified,{},cache));
  assert.equal(changedCalls,8,'Changed older context invalidates later judgments even after its anchor leaves the bounded view.');
});

test('historical bugfix anchors protect supporting prose through continuations outside the last two groups',async()=>{
  const records=[user('Fix the map regression.',0),user('continue plz',1),assistant('The map now retains its previous value.',2),
    user('Design a landing page.',3),user('Prepare a garden plan.',4),assistant('The weather looks pleasant.',5)];
  const {groups}=await grouped(records,['continuation','new_task','new_task']);
  const prepared=prepareRelevance(records,{taskGroups:groups});
  assert.equal(prepared.usable,true);
  assert.deepEqual(prepared.candidates.map(item=>item.entry),[2,5]);
  assert.equal(prepared.candidates[0].sourceRequest,'Fix the map regression.\n\ncontinue plz');
  await judgeRelevance({systemOne:async({questions})=>({answers:Object.fromEntries(Object.keys(questions).map(id=>[id,{type:'noul',noul:id.endsWith('_bugfix')?0.95:0}]))})},sdk,prepared);
  assert.ok(selectRelevance(prepared).every(item=>item.keep));
  assert.equal(renderRelevance(records,prepared).find(item=>item.entry===2).text,records[2].text);
});

test('cache contains only judgments and invalidates changed request, model or supporting context',async()=>{
  const records=[user('Document the API.',0),assistant('The document is ready for examples.',1),user('Include field types.',2)];
  const {cache}=await grouped(records,['steering'],{model:'synthetic-model'});
  const prepared=prepareTaskGroups(records,{model:'synthetic-model'},cache),usage={};
  await judgeTaskGroups({systemOne:async()=>assert.fail('Unchanged judgments must be cached')},sdk,prepared,usage);
  assert.equal(usage.cached,1);assert.ok(!JSON.stringify(cache).includes('Document the API'));
  for(const [changed,model] of [[records,'other-model'],[[records[0],assistant('The document is not ready.',1),records[2]],'synthetic-model'],[[...records.slice(0,2),user('Include response schemas.',2)],'synthetic-model']]) {
    let calls=0;
    await judgeTaskGroups({systemOne:async()=>{calls++;return {answers:{relation:certain('steering')}};}},sdk,prepareTaskGroups(changed,{model},cache));
    assert.equal(calls,1);
  }
});

test('deterministic removals never become grouping context and raw records remain unchanged',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'tc-task-groups-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'transcript.jsonl');
  const message=(role,text)=>({type:'response_item',payload:{type:'message',role,content:[{type:'text',text}]}});
  const entries=[message('user','Document the API.'),message('assistant','The document is ready.'),message('assistant','The document is ready.'),
    {type:'response_item',payload:{type:'function_call',call_id:'noop',name:'exec_command',arguments:'{"cmd":"true"}'}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'noop',output:JSON.stringify({exit_code:0,output:''})}},message('user','continue plz')];
  const raw=entries.map(JSON.stringify).join('\n');writeFileSync(path,raw);
  const {records}=loadRecords(path);protectRecords(records,5);dedupPayloads(records);runPolicies(records);
  assert.ok([1,3,4].every(index=>records[index].removed));
  const original=structuredClone(records),prepared=prepareTaskGroups(records);
  await judgeTaskGroups({systemOne:async({state})=>{
    assert.deepEqual(state.precedingAssistant,{entry:2,text:'The document is ready.'});
    assert.equal(state.nextRequest.entry,5);return {answers:{relation:certain('continuation')}};
  }},sdk,prepared);
  assert.equal(taskGroupsFor(prepared).groups.length,1);
  assert.deepEqual(records,original);assert.equal(readFileSync(path,'utf8'),raw);
});

test('independent older-task gate narrows only local ambiguity and retains actual returns',async()=>{
  const records=users(['Fix the historical cache regression.','Create an unrelated marketing page.','Build a firmware release.','Use an empty layer for that release.']);
  for(const olderDependency of [0.01,0.7,null]) {
    const prepared=prepareTaskGroups(records);let boundary=0;
    await judgeTaskGroups({systemOne:async({questions})=> ({answers:{...(questions.relation?{relation:certain(['new_task','new_task','uncertain'][boundary++])}:{}),...(questions.olderDependency?{olderDependency:{type:'noul',noul:olderDependency}}:{})}})},sdk,prepared);
    const descriptor=taskGroupsFor(prepared),relevance=prepareRelevance(records,{taskGroups:descriptor});
    assert.equal(descriptor.groups.at(-1).uncertain,true);
    assert.equal(relevance.benchmark.length,olderDependency===0.01?2:3);
    assert.deepEqual(descriptor.groups.flatMap(group=>group.members),cleanedUserRequests(records));
    const missing=structuredClone(descriptor);delete missing.decisions.at(-1).olderPromptHash;
    assert.equal(prepareRelevance(records,{taskGroups:missing}).benchmark.length,3);
  }
});
