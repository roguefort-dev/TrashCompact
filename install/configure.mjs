#!/usr/bin/env node
// Merge (or remove) the TrashCompact hooks in ~/.codex/hooks.json.
//
// Only ever touches the three hook entries it owns: everything else in the file is
// read, preserved, and written back untouched. Validate and write atomically
// so unrelated hook configuration remains intact.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from 'node:os';
import { hookInvocation } from './platform.mjs';
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installerArgs } from './args.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { target, remove } = installerArgs(process.argv.slice(2), ['codex', 'claude']);
const home = process.env.HOME || homedir();
const SETTINGS = target === 'claude' ? join(home, '.claude', 'settings.json') : join(process.env.CODEX_HOME || join(home, ".codex"), "hooks.json");
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";


const entries = {
  Stop: {
    hooks: [{
      type: "command",
      command: `${quote(join(ROOT, "bin", "trashcompact-hook"))} stop`,
      async: true,
      timeout: 120,
      statusMessage: "TrashCompact: scoring newly eligible entries",
    }],
  },
  PreCompact: {
    hooks: [{
      type: "command",
      command: `${quote(join(ROOT, "bin", "trashcompact-hook"))} precompact`,
      timeout: 65,
      statusMessage: "TrashCompact: scoring recovery evidence before compaction",
    }],
  },
  SessionStart: {
    matcher: "^compact$",
    hooks: [{
      type: "command",
      command: `${quote(join(ROOT, "bin", "trashcompact-hook"))} sessionstart`,
      timeout: 5,
      additionalContextLimit: 6000,
      statusMessage: "TrashCompact: restoring recovery note",
    }],
  },
};

if (target === 'claude') {
  for (const [event, entry] of Object.entries(entries)) {
    const hook = entry.hooks[0];
    hook.command = `${quote(join(ROOT, 'bin', 'trashcompact-hook'))} claude-${event.toLowerCase()}`;
    delete hook.statusMessage;
    delete hook.additionalContextLimit;
  }
}

for (const [event, entry] of Object.entries(entries)) {
  Object.assign(entry.hooks[0], hookInvocation(ROOT, target, event.toLowerCase()));
}

// Exact commands from this installation only; a substring is not ownership.
const owned = new Set(Object.values(entries).map(entry => entry.hooks[0].command));
for (const [mode, script] of [['stop', 'on-stop.mjs'], ['precompact', 'on-precompact.mjs'], ['sessionstart', 'on-sessionstart.mjs']]) {
  const dispatcher = join(ROOT, 'bin', 'trashcompact-hook');
  const dispatchMode = target === 'claude' ? `claude-${mode}` : mode;
  owned.add(`${quote(dispatcher)} ${dispatchMode}`);
  owned.add(`${dispatcher} ${dispatchMode}`); // legacy unquoted installer
  for (const path of [join(ROOT, 'hooks', target === 'claude' ? `claude-${script}` : script)]) {
    owned.add(`node ${path}`);
    owned.add(`node ${quote(path)}`);
  }
}
const isOurs = hook => hook?.type === 'command' && (
  Object.values(entries).some(entry => {
    const expected = entry.hooks[0];
    return hook.command === expected.command && JSON.stringify(hook.args) === JSON.stringify(expected.args) && hook.commandWindows === expected.commandWindows;
  }) || (!Object.hasOwn(hook, 'args') && !Object.hasOwn(hook, 'commandWindows') && owned.has(hook.command) && hook.command !== process.execPath)
);

if (remove && !existsSync(SETTINGS)) process.exit(0);
let settings = {};
if (existsSync(SETTINGS)) {
  try {
    settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch {
    console.error("refusing to touch unreadable or malformed hooks.json");
    process.exit(1);
  }
}

if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
    (settings.hooks != null && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)))) {
  throw new Error('Refusing invalid settings structure');
}
settings.hooks ??= {};
for (const event of Object.keys(entries)) {
  const groups = settings.hooks[event] ?? [];
  if (!Array.isArray(groups)) throw new Error('Refusing invalid hook groups');
  const existing = groups.flatMap(group => {
    if (!Array.isArray(group?.hooks)) return [group];
    const hooks = group.hooks.filter(hook => !isOurs(hook));
    if (hooks.length === group.hooks.length) return [group];
    return hooks.length ? [{ ...group, hooks }] : [];
  });
  const next = remove || !entries[event] ? existing : [...existing, entries[event]];
  if (next.length) settings.hooks[event] = next;
  else delete settings.hooks[event];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

const serialized = `${JSON.stringify(settings, null, 2)}\n`;
JSON.parse(serialized); // never write something we cannot read back
mkdirSync(dirname(SETTINGS), { recursive: true });
const temporary = mkdtempSync(join(dirname(SETTINGS), '.trashcompact-'));
try {
  const staging = join(temporary, 'hooks.json');
  const mode = existsSync(SETTINGS) ? statSync(SETTINGS).mode & 0o777 : 0o600;
  writeFileSync(staging, serialized, { mode, flag: 'wx' });
  renameSync(staging, SETTINGS);
} finally { rmSync(temporary, { recursive: true, force: true }); }

console.log(`${remove ? 'removed' : 'wired'} ${target} Stop, PreCompact and SessionStart hooks${!remove && target === 'codex' ? '; review and trust them using /hooks' : ''}`);
