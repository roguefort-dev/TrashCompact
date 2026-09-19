import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {discoveredEndpoint,discoverServer,supervise,watcherArguments} from '../opencode2/service.mjs';
import {installService,findExecutable,serviceUnit} from '../opencode2/install-service.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'opencode-service-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('read-only discovery accepts reported local endpoints and rejects stopped, remote, embedded secrets or noise',async()=>{
 assert.equal(discoveredEndpoint('http://127.0.0.1:45678\n'),'http://127.0.0.1:45678');
 assert.equal(discoveredEndpoint('http://[::1]:1234'),'http://[::1]:1234');
 for(const value of ['stopped','https://example.com','http://user:secret@localhost:42','http://localhost:42?password=secret','noise\nhttp://localhost:42'])assert.equal(discoveredEndpoint(value),null);
 let invoked;const result=await discoverServer('/actual/opencode2',async(...args)=>{invoked=args;return {stdout:'http://localhost:9876\n'};});
 assert.equal(result,'http://localhost:9876');assert.deepEqual(invoked.slice(0,2),['/actual/opencode2',['service','status']]);
 assert.equal(await discoverServer('missing',async()=>{throw new Error('secret internal response');}),null);
});
test('supervisor waits for normal server, covers all projects and restarts on discovered endpoint changes',async()=>{
 const endpoints=[null,'http://localhost:1234','http://localhost:1234','http://localhost:5678',null],spawned=[],killed=[];
 const controller=new AbortController();let polls=0;
 await supervise({opencode:'opencode2',watcher:'/repo/auto-compact.mjs',state:'/private/state',passwordFile:'/private/service.json',signal:controller.signal},{
  discover:async()=>endpoints[polls++],wait:async()=>{if(polls===endpoints.length)controller.abort();},
  launch:args=>{spawned.push(args);const child=new EventEmitter();child.exitCode=null;child.kill=signal=>{killed.push(signal);child.exitCode=0;queueMicrotask(()=>child.emit('exit',0));};return child;},
 });
 assert.equal(spawned.length,2);assert.equal(killed.length,2);
 assert.ok(spawned.every(args=>!args.includes('--directory')));
 assert.equal(spawned[0][spawned[0].indexOf('--server')+1],'http://localhost:1234');
 assert.equal(spawned[1][spawned[1].indexOf('--server')+1],'http://localhost:5678');
 assert.ok(spawned.every(args=>args.includes('--password-file')&&!args.includes('--password')));
 assert.ok(spawned.every(args=>args[args.indexOf('--service-identity')+1]==='opencode2-background'));
});
test('installer installs and removes only owned unit with mocked user manager and preserves cache/config',t=>{
 const home=fixture(t),bin=join(home,'bin');mkdirSync(bin);writeFileSync(join(bin,'real-opencode2'),'#!/bin/sh\n',{mode:0o700});symlinkSync(join(bin,'real-opencode2'),join(bin,'opencode2'));
 const env={HOME:home,PATH:bin},calls=[],systemctl=args=>{calls.push(args);return {status:0};};
 const path=installService({env,systemctl});const unit=readFileSync(path,'utf8');
 assert.match(unit,/WantedBy=default.target/);assert.match(unit,/StandardOutput=null/);assert.match(unit,/StandardError=journal/);assert.match(unit,/TimeoutStopSec=30/);assert.match(unit,/--password-file/);
 assert.ok(!unit.includes('--password '));assert.equal(findExecutable('opencode2',bin),join(bin,'real-opencode2'));
 assert.deepEqual(calls,[['daemon-reload'],['enable','trashcompact-opencode2.service'],['restart','trashcompact-opencode2.service']]);
 const cache=join(home,'.local/state/trashcompact/opencode2-state.json');writeFileSync(cache,'preserve');
 installService({remove:true,env,systemctl});assert.ok(!existsSync(path));assert.equal(readFileSync(cache,'utf8'),'preserve');
 assert.deepEqual(calls.slice(-2),[['disable','--now','trashcompact-opencode2.service'],['daemon-reload']]);
 mkdirSync(join(home,'.config/systemd/user'),{recursive:true});writeFileSync(path,'user-owned');
 assert.throws(()=>installService({env,systemctl}),/unowned/);assert.throws(()=>installService({remove:true,env,systemctl}),/unowned/);
 assert.equal(readFileSync(path,'utf8'),'user-owned');
});
test('service unit quotes paths without embedding credential contents',()=>{
 const unit=serviceUnit({node:'/path with spaces/node',opencode:'/tools/opencode2',configHome:'/cfg % home',stateHome:'/state',root:'/repo'});
 assert.match(unit,/"\/path with spaces\/node"/);assert.match(unit,/\/cfg %% home/);assert.ok(!unit.includes('OPENCODE_SERVER_PASSWORD'));
 assert.throws(()=>serviceUnit({opencode:'/tools/evil\n[Service]',configHome:'/cfg',stateHome:'/state'}),/Invalid service path/);
 assert.deepEqual(watcherArguments({watcher:'/watch',server:'http://localhost:123',state:'/state',passwordFile:'/secret-file',directory:'/project'}).slice(-2),['--directory','/project']);
});
