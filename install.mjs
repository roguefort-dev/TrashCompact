#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { npmInvocation } from './install/platform.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const usage = 'Usage: node install.mjs [--target codex|claude|opencode|opencode2] [--non-interactive] [--uninstall]';
let target = 'codex', remove = false, noninteractive = false;
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (['--help', '-h'].includes(args[i])) { console.log(usage); process.exit(0); }
    if (args[i] === '--target' && ['codex', 'claude', 'opencode', 'opencode2'].includes(args[i + 1])) target = args[++i];
    else if (args[i] === '--non-interactive') noninteractive = true;
    else if (args[i] === '--uninstall') remove = true;
    else { console.error(usage); process.exit(2); }
  }
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.');
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Installer step failed with exit code ${result.status ?? 1}.`);
  };
  if (!remove && !existsSync(join(root, 'node_modules', '@typesafe-ai', 'sdk'))) {
    const [command, args] = npmInvocation();
    run(command, [...args, existsSync(join(root, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund']);
  }
  const config = ['codex', 'claude'].includes(target) ? 'install/configure.mjs' : 'opencode/install.mjs';
  const flags = ['--target', target, ...(remove ? ['--remove'] : [])];
  run(process.execPath, [join(root, config), ...flags]);
  run(process.execPath, [join(root, 'install/skills.mjs'), ...flags]);
  if (remove) console.log('Integration removed; API key and cached verdicts preserved.');
  else {
    const keyFile = process.env.TRASHCOMPACT_ENV || join(process.env.HOME || homedir(), '.config', 'typesafe', 'env');
    if (!noninteractive && process.stdin.isTTY && !existsSync(keyFile) && !process.env.TYPESAFE_API_KEY) run(process.execPath, [join(root, 'install/key.mjs')]);
    console.log(`Installed for ${target}. To enter or replace your API key, run from this checkout:\nnode install/key.mjs`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
