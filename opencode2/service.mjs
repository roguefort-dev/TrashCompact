#!/usr/bin/env node
// Read-only endpoint discovery. This supervisor never starts OpenCode itself.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const exec = promisify(execFile);
export function discoveredEndpoint(stdout) {
  const value = stdout.trim();
  if (!value || value === 'stopped') return null;
  try {
    const url = new URL(value);
    if (!['http:','https:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}
export async function discoverServer(executable = 'opencode2', execute = exec) {
  try {
    const { stdout } = await execute(executable,['service','status'],{timeout:5000,maxBuffer:8192,encoding:'utf8'});
    return discoveredEndpoint(stdout);
  } catch { return null; }
}
export function watcherArguments({ server, state, passwordFile, directory, watcher }) {
  return [watcher,'--server',server,'--state',state,'--password-file',passwordFile,'--service-identity','opencode2-background',...(directory ? ['--directory',directory] : [])];
}
export async function supervise(options, dependencies = {}) {
  const discover = dependencies.discover ?? (()=>discoverServer(options.opencode));
  const launch = dependencies.launch ?? (args=>spawn(process.execPath,args,{stdio:['ignore','ignore','inherit'],env:process.env}));
  const wait = dependencies.wait ?? (ms=>new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,ms);options.signal?.addEventListener('abort',done,{once:true});
  }));
  let child=null, current=null, childFailed=false;
  const stop = async () => {
    if (!child) return;
    const target=child; child=null;current=null;
    if (target.exitCode != null || childFailed) {childFailed=false;return;}
    await new Promise(resolve=>{
      let finished=false;
      const done=()=>{if(finished)return;finished=true;clearTimeout(timer);resolve();};
      const timer=setTimeout(()=>{try{target.kill('SIGKILL');}catch{}done();},20000);
      target.once('exit',done);
      try{target.kill('SIGTERM');}catch{done();}
    });
  };
  try {
    while (!options.signal?.aborted) {
      const server=await discover();
      if (server!==current || child?.exitCode != null) await stop();
      if (server && !child && !options.signal?.aborted) {
        childFailed=false;child=launch(watcherArguments({...options,server}));current=server;
        const launched=child;
        child.on('error',()=>{if(child===launched){current=null;childFailed=true;}}); // No credential-bearing errors in logs.
      }
      if (options.once || options.signal?.aborted) break;
      await wait(options.pollMs ?? 5000);
    }
  } finally { await stop(); }
}
export function serviceOptions(argv, env=process.env) {
  const home=env.HOME || homedir();
  const options={opencode:'opencode2',state:join(env.XDG_STATE_HOME || join(home,'.local/state'),'trashcompact/opencode2-state.json'),
    passwordFile:join(env.XDG_CONFIG_HOME || join(home,'.config'),'opencode/service.json'),watcher:join(dirname(fileURLToPath(import.meta.url)),'auto-compact.mjs')};
  const valued=new Map([['--opencode','opencode'],['--state','state'],['--password-file','passwordFile'],['--directory','directory']]);
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==='--once'){options.once=true;continue;}
    if(!valued.has(argv[i]) || !argv[i+1] || argv[i+1].startsWith('--'))throw new Error('Invalid supervisor arguments');
    options[valued.get(argv[i])]=argv[++i];
  }
  return options;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const controller=new AbortController();process.on('SIGTERM',()=>controller.abort());process.on('SIGINT',()=>controller.abort());
  try{await supervise({...serviceOptions(process.argv.slice(2)),signal:controller.signal});}
  catch{process.stderr.write('trashcompact: companion unavailable\n');process.exitCode=1;}
}
