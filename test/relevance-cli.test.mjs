import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRecords, protectRecords, dedupPayloads, runPolicies, parseArguments } from '../src/filter-transcript.mjs';
import { openState, saveState, loadState, completeCompaction } from '../src/scoring-state.mjs';
import { prepareTaskGroups, judgeTaskGroups, taskGroupsFor } from '../src/task-groups.mjs';
import { prepareRelevance, judgeRelevance, renderRelevance } from '../src/relevance.mjs';
const sdk={choice:(instructions,choices)=>({instructions,choices}),noul:(instructions,criteria)=>({instructions,criteria})};
const model='jev-1.13.0';
const certain={type:'choice',choice:'new_task',confidence:1,probabilities:{continuation:0,steering:0,new_task:1,uncertain:0}};

test('offline relevance exports exact derived spans, keeps fixes and source, and ignores original recovery offsets',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'tc-relevance-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const input=join(dir,'input.jsonl'),path=join(dir,'state.json');
  const message=(role,text)=>({type:'response_item',payload:{type:'message',role,content:[{type:'text',text}]}});
  const raw=[message('user','Document the API.'),message('assistant','I will inspect the documentation next.\n\nThe bug fix preserves empty map values.'),message('user','Design a garden.')].map(JSON.stringify).join('\n');
  writeFileSync(input,raw);
  const {records,epoch}=loadRecords(input);protectRecords(records,0);dedupPayloads(records);runPolicies(records,0);
  const state=openState(path,epoch),groups=prepareTaskGroups(records,{model});
  state.taskGroups=await judgeTaskGroups({systemOne:async()=>({answers:{relation:certain}})},sdk,groups);
  const prepared=prepareRelevance(records,{model,taskGroups:taskGroupsFor(groups)});
  state.relevance=await judgeRelevance({systemOne:async({questions})=>({answers:Object.fromEntries(Object.keys(questions).map(id=>[id,{type:'noul',noul:0}]))})},sdk,prepared);
  saveState(path,state);
  const snapshot=readFileSync(path,'utf8');
  for(const mode of [['--digest'],['--recovery','--recovery-rank']]) {
    const result=spawnSync(process.execPath,['src/filter-transcript.mjs',input,'--offline','--relevance','--keep-tail','0','--state',path,...mode],{encoding:'utf8',env:{...process.env,TYPESAFE_API_KEY:''}});
    assert.equal(result.status,0,result.stderr);
    assert.ok(!result.stdout.includes('I will inspect the documentation next.'));
    assert.ok(result.stdout.includes('The bug fix preserves empty map values.'));
    assert.ok(result.stdout.includes('Document the API.'));
    assert.ok(result.stdout.includes('Design a garden.'));
    assert.match(result.stderr,/1 exact omissions/);
  }
  assert.equal(readFileSync(input,'utf8'),raw);assert.equal(readFileSync(path,'utf8'),snapshot);
  completeCompaction(path,'next','boundary');
  assert.equal(loadState(path).relevance,undefined);assert.equal(loadState(path).taskGroups,undefined);
  assert.throws(()=>saveState(path,state),/changed after native compaction/);
});

test('cached-only grouping and relevance never call the SDK or claim requests',async()=>{
  const records=[{index:0,role:'user',category:'human_instruction',text:'Document the API.'},{index:1,role:'user',category:'human_instruction',text:'Design a garden.'},{index:2,role:'assistant',category:'prose',text:'An unrelated note.'}];
  const groups=prepareTaskGroups(records,{cachedOnly:true}),usage={};
  await judgeTaskGroups(null,null,groups,usage);
  const prepared=prepareRelevance(records,{cachedOnly:true,taskGroups:taskGroupsFor(groups)});
  await judgeRelevance(null,null,prepared,usage);
  assert.deepEqual(usage,{});
  assert.deepEqual(renderRelevance(records,prepared).map(item=>item.text),records.map(item=>item.text));
  assert.equal(parseArguments(['input','--relevance','--update']).relevance,true);
  assert.throws(()=>parseArguments(['input','--relevance']),/derived text/);
});

test('checkpoints persist completed semantic batches before subsequent failure',async()=>{
  const records=[{index:0,role:'user',category:'human_instruction',text:'Document the API.'},{index:1,role:'user',category:'human_instruction',text:'Design a garden.'},{index:2,role:'assistant',category:'prose',text:'First note.\n\nSecond note.'}];
  const prepared=prepareRelevance(records,{batch:1});let calls=0,saved;
  await judgeRelevance({systemOne:async({questions})=>{if(calls++)throw Error('unavailable');return {answers:Object.fromEntries(Object.keys(questions).map(id=>[id,{type:'noul',noul:0}]))};}},sdk,prepared,{}, {},next=>{saved=structuredClone(next);});
  assert.equal(Object.keys(saved.verdicts).length,1);
  assert.equal(prepared.candidates[1].verdict,null);
});
