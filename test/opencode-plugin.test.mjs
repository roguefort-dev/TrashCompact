import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { convertMessages, createPlugin, createRecovery } from '../opencode/plugin.mjs';
import { installPlugin } from '../opencode/install.mjs';
const note = '[TrashCompact recovery context] Keep the API contract.';
const messages = [{role:'user',content:[{type:'text',text:'Keep the API contract.'},{type:'media',data:'private'}]}, {role:'assistant',content:[{type:'reasoning',text:'hidden'},{type:'text',text:'Implemented.'},{type:'tool-call',id:'c',name:'read',input:{path:'app.js'}}]}, {role:'tool',content:[{type:'tool-result',id:'c',result:{type:'content',value:[{type:'text',text:'export default 1;'},{type:'file',uri:'secret'}]}}]}, {role:'system',content:[{type:'text',text:'private instructions'}]}];
test('conversion only includes known visible text and tool fields',()=> {
 const records=convertMessages(messages,2), raw=JSON.stringify(records);
 assert.equal(records.length,4); assert.ok(!/private|hidden|secret/.test(raw));
 assert.equal(records[3].payload.type,'function_call_output');
 const v1=convertMessages([{info:{role:'assistant'},parts:[{type:'reasoning',text:'hidden'},{type:'tool',callID:'t',tool:'read',state:{status:'completed',input:{filePath:'x'},output:'contents',metadata:{private:'secret'}}}]}],1);
 assert.equal(v1.length,2); assert.ok(!JSON.stringify(v1).includes('secret'));
});
test('compaction callbacks enrich native summary with bounded note and clean temporary transcript',async()=> {
 const root=await mkdtemp(join(tmpdir(),'tc-plugin-test-')); const calls=[];
 try {
  const plugin=createPlugin({temporaryRoot:root,env:{HOME:root},run:async(args,timeout)=>{
   calls.push({args,timeout,raw:await readFile(args[0],'utf8')}); assert.equal((await stat(args[0])).mode & 0o777,0o600);
   return args.includes('--offline')?note:null;
  }});
  let hook; await plugin.setup({location:{directory:'/project'},session:{hook:async(name,fn)=>{assert.equal(name,'compaction');hook=fn;}}});
  const event={sessionID:'a',messages,system:[{type:'text',text:'native'}]}; await hook(event);
  assert.deepEqual(event.system,[{type:'text',text:'native'},{type:'text',text:note}]); assert.equal(event.result,undefined);
  assert.deepEqual(calls.map(c=>c.timeout),[45000,10000]); assert.ok(calls[0].args.includes('--recovery-rank'));
  await assert.rejects(stat(calls[0].args[0]),{code:'ENOENT'});
  const stateA=calls[0].args[calls[0].args.indexOf('--state')+1];
  await hook({...event,sessionID:'b',system:[]}); assert.notEqual(stateA,calls[2].args[calls[2].args.indexOf('--state')+1]);
  const v1=await plugin.server({directory:'/project',client:{session:{messages:async(req)=>{assert.equal(req.path.id,'v1');return {data:[{info:{role:'user'},parts:[{type:'text',text:'hello'}]}]};}}}});
  const output={context:['native']}; await v1['experimental.session.compacting']({sessionID:'v1'},output); assert.deepEqual(output.context,['native',note]);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('invalid notes, API failures, and unsupported data fail open',async()=> {
 const root=await mkdtemp(join(tmpdir(),'tc-plugin-test-'));
 try {
  for(const bad of [null,'wrong','[TrashCompact recovery context]'+ 'x'.repeat(6000)]) {
   const recovery=createRecovery({temporaryRoot:root,env:{HOME:root},run:async()=>bad});
   assert.equal(await recovery({sessionID:'a',directory:'/p',version:2,messages}),undefined);
  }
  const plugin=createPlugin(); const hooks=await plugin.server({client:{session:{messages:async()=>{throw Error('offline');}}},directory:'/p'});
  const output={context:[]}; await hooks['experimental.session.compacting']({sessionID:'a'},output); assert.deepEqual(output.context,[]);
  assert.equal((await readdir(root)).filter(x=>x.startsWith('trashcompact-opencode-')).length,0);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('installer is idempotent, preserves config and refuses conflicting loader',async()=> {
 const root=await mkdtemp(join(tmpdir(),'tc install with spaces '));
 try {
  const env={HOME:root,XDG_CONFIG_HOME:join(root,'config')};
  const path=await installPlugin({target:'opencode',env});
  assert.equal(await installPlugin({target:'opencode2',env}),path);
  assert.equal((await import(pathToFileURL(path).href)).default.id,'trashcompact');
  await installPlugin({target:'opencode2',env,remove:true}); await assert.rejects(stat(path),{code:'ENOENT'});
  await writeFile(path,'user plugin'); await assert.rejects(installPlugin({target:'opencode',env}),/unowned/);
  await assert.rejects(installPlugin({target:'opencode2',env,remove:true}),/unowned/); assert.equal(await readFile(path,'utf8'),'user plugin');
 } finally {await rm(root,{recursive:true,force:true});}
});
test('compatibility rejects the known broken beta and old v1 under either executable name',async()=> {
 const {checkCompatibility}=await import('../opencode/install.mjs');
 const root=await mkdtemp(join(tmpdir(),'tc-version-'));
 try {
  for(const target of ['opencode','opencode2']) {
   const path=join(root,target), env={PATH:root};
   for(const version of ['0.0.0-beta-19157','1.18.28']) {
    await writeFile(path,`#!/bin/sh\nprintf '%s\\n' '${version}'\n`,{mode:0o700});
    await assert.rejects(checkCompatibility(target,env),/beta-19157|1.18.29/);
   }
   await writeFile(path,"#!/bin/sh\nprintf '%s\\n' '2.0.10'\n",{mode:0o700});
   assert.match((await checkCompatibility(target,env)).reason,/2.0.10/);
  }
  await assert.rejects(checkCompatibility('bad',{PATH:root}),/Target/);
  assert.equal((await checkCompatibility('opencode',{PATH:join(root,'missing')})).verified,false);
 } finally {await rm(root,{recursive:true,force:true});}
});
