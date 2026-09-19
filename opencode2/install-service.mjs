#!/usr/bin/env node
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
const UNIT='trashcompact-opencode2.service';
const marker=`# Managed by TrashCompact: ${ROOT}`;
const quote=value=>{if(/[\r\n\0]/.test(value))throw new Error('Invalid service path');return '"'+value.replaceAll('%','%%').replaceAll('$','$$').replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';};
export function findExecutable(name, path=process.env.PATH ?? '') {
  for(const parent of path.split(delimiter)) {
    const executable=join(parent,name);
    try{accessSync(executable,constants.X_OK);return realpathSync(executable);}catch{}
  }
  throw new Error('OpenCode 2 executable not found on PATH');
}
export function serviceUnit({node=process.execPath,opencode,configHome,stateHome,root=ROOT}) {
  const command=[node,join(root,'opencode2/service.mjs'),'--opencode',opencode,'--state',join(stateHome,'trashcompact/opencode2-state.json'),'--password-file',join(configHome,'opencode/service.json')].map(quote).join(' ');
  return `${marker}\n[Unit]\nDescription=TrashCompact OpenCode 2 response companion\n\n[Service]\nType=simple\nEnvironment=${quote(`XDG_CONFIG_HOME=${configHome}`).replaceAll('$$','$')}\nEnvironment=${quote(`XDG_STATE_HOME=${stateHome}`).replaceAll('$$','$')}\nExecStart=${command}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nUMask=0077\nStandardOutput=null\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n`;
}
export function installService({remove=false,env=process.env,systemctl=(args)=>spawnSync('systemctl',['--user',...args],{encoding:'utf8',stdio:'pipe'})}={}) {
  const configHome=env.XDG_CONFIG_HOME || join(env.HOME || homedir(),'.config');
  const stateHome=env.XDG_STATE_HOME || join(env.HOME || homedir(),'.local/state');
  const destination=join(configHome,'systemd/user',UNIT);
  if(existsSync(destination)&&!readFileSync(destination,'utf8').startsWith(marker+'\n'))throw new Error('Refusing to replace an unowned service unit');
  const run=args=>{const result=systemctl(args);if(result.status!==0)throw new Error('User service manager operation failed');};
  if(remove) {
    if(!existsSync(destination))return destination;
    run(['disable','--now',UNIT]);unlinkSync(destination);run(['daemon-reload']);return destination;
  }
  const opencode=findExecutable('opencode2',env.PATH);
  const unit=serviceUnit({opencode,configHome,stateHome});
  mkdirSync(dirname(destination),{recursive:true});mkdirSync(join(stateHome,'trashcompact'),{recursive:true,mode:0o700});
  const temporary=destination+`.${process.pid}.tmp`;
  writeFileSync(temporary,unit,{mode:0o600,flag:'wx'});renameSync(temporary,destination);
  run(['daemon-reload']);run(['enable',UNIT]);run(['restart',UNIT]);
  return destination;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{
    if(!['--install','--uninstall'].includes(process.argv[2])||process.argv.length!==3)throw new Error('Use --install or --uninstall');
    const remove=process.argv[2]==='--uninstall';installService({remove});
    process.stdout.write(remove?'TrashCompact OpenCode 2 companion removed; cached state retained.\n':'TrashCompact OpenCode 2 companion enabled; waits for the normal OpenCode server.\n');
  }catch(error){process.stderr.write(`trashcompact: ${error.message}\n`);process.exitCode=1;}
}
