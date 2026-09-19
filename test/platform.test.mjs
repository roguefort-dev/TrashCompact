import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hookInvocation, npmInvocation } from '../install/platform.mjs';
import { runCli } from '../hooks/common.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'tc platform '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, "checkout with ' & spaces");
  mkdirSync(repo);
  for (const name of ['install.mjs', 'install', 'skill', 'hooks', 'bin', 'src', 'opencode']) cpSync(join(root, name), join(repo, name), { recursive: true });
  mkdirSync(join(repo, 'node_modules', '@typesafe-ai', 'sdk'), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), XDG_CONFIG_HOME: join(home, '.config'), TYPESAFE_API_KEY: '', TRASHCOMPACT_ENV: join(home, 'absent-env') };
  const run = (...args) => spawnSync(process.execPath, [join(repo, 'install.mjs'), '--non-interactive', ...args], { env, encoding: 'utf8' });
  return { home, repo, env, run };
}

test('Windows hooks quote paths through encoded PowerShell or Claude exec form', () => {
  const repo = "C:\\Users\\O'Brien & Co\\TrashCompact", node = 'C:\\Program Files\\nodejs\\node.exe';
  const codex = hookInvocation(repo, 'codex', 'precompact', 'win32', node);
  assert.equal(codex.command, codex.commandWindows);
  assert.match(codex.commandWindows, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const decoded = Buffer.from(codex.commandWindows.split(' ').at(-1), 'base64').toString('utf16le');
  assert.equal(decoded, "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\O''Brien & Co\\TrashCompact\\hooks\\on-precompact.mjs'; exit $LASTEXITCODE");
  assert.deepEqual(hookInvocation(repo, 'claude', 'stop', 'win32', node), {
    command: node, args: [repo + '\\hooks\\claude-on-stop.mjs'],
  });
});

test('portable installer is idempotent and uninstall preserves unrelated hooks', t => {
  const f = fixture(t);
  for (const target of ['codex', 'claude']) {
    const path = join(f.home, target === 'codex' ? '.codex/hooks.json' : '.claude/settings.json');
    mkdirSync(dirname(path), { recursive: true });
    const unrelated = { type: 'command', command: process.execPath, args: ['unrelated.mjs'] };
    writeFileSync(path, JSON.stringify({ userSetting: true, hooks: { Stop: [{ hooks: [unrelated] }] } }));
    for (let i = 0; i < 2; i++) {
      const result = f.run('--target', target); assert.equal(result.status, 0, result.stderr);
    }
    const settings = JSON.parse(readFileSync(path));
    assert.equal(settings.hooks.Stop.length, 2);
    assert.deepEqual(settings.hooks.Stop[0].hooks, [unrelated]);
    const removed = f.run('--target', target, '--uninstall'); assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path)), { userSetting: true, hooks: { Stop: [{ hooks: [unrelated] }] } });
    assert.equal(existsSync(join(f.home, target === 'codex' ? '.codex' : '.claude', 'skills/trashcompact')), false);
  }
});

test('skill uninstall preserves a junction or link owned by another checkout', t => {
  const f = fixture(t), other = join(f.home, 'other skill');
  mkdirSync(other); writeFileSync(join(other, 'keep'), 'user data');
  const destination = join(f.home, '.codex/skills/trashcompact');
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(other, destination, process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.run('--uninstall'); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(destination, 'keep'), 'utf8'), 'user data');
});

test('portable OpenCode install shares one owned plugin and skill', t => {
  const f = fixture(t);
  f.env.PATH = '';
  const plugin = join(f.home, '.config/opencode/plugins/trashcompact.js');
  for (const target of ['opencode', 'opencode2']) {
    const installed = f.run('--target', target);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(readFileSync(plugin, 'utf8'), /export \{ default \} from "file:/);
  }
  const removed = f.run('--target', 'opencode2', '--uninstall');
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(plugin), false);
  assert.equal(existsSync(join(f.home, '.config/opencode/skills/trashcompact')), false);
});

test('CLI and hook subprocesses use Node directly with literal arguments', async t => {
  const f = fixture(t), stub = join(f.repo, 'literal args.mjs');
  writeFileSync(stub, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const args = ['space and quote\' & $HOME', '--offline'];
  assert.deepEqual(JSON.parse(await runCli(args, 5000, stub)), args);
  const transcript = join(f.home, 'conversation.jsonl');
  writeFileSync(transcript, JSON.stringify({type:'user',message:{content:'Keep the API contract.'}}));
  const result = spawnSync(process.execPath, [join(f.repo, 'bin/launch.mjs'), transcript, '--offline', '--plan'], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('npm invocation resolves a JS entry point without executing a shell', t => {
  const f = fixture(t), script = join(f.home, 'npm with spaces', 'npm-cli.js');
  mkdirSync(dirname(script)); writeFileSync(script, '');
  assert.deepEqual(npmInvocation({ npm_execpath: script, PATH: '' }), [process.execPath, [script]]);
});

test('native Windows generated hooks pass stdin and preserve JSON stdout', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  for (const target of ['codex', 'claude']) {
    const script = join(f.repo, 'hooks', `${target === 'claude' ? 'claude-' : ''}on-sessionstart.mjs`);
    writeFileSync(script, "let text=''; for await (const chunk of process.stdin) text+=chunk; console.log(JSON.stringify({received:JSON.parse(text)}));");
    const hook = hookInvocation(f.repo, target, 'sessionstart');
    const input = { session_id: "a '& session", source: 'compact' };
    const result = target === 'codex'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', hook.commandWindows], { input: JSON.stringify(input), encoding: 'utf8', env: f.env })
      : spawnSync(hook.command, hook.args, { input: JSON.stringify(input), encoding: 'utf8', env: f.env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { received: input });
  }
});

test('Windows installer uses USERPROFILE when HOME is absent', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  delete f.env.HOME;
  const result = f.run('--target', 'claude');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.home, '.claude/settings.json')));
  const removed = f.run('--target', 'claude', '--uninstall');
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(join(f.home, '.claude/skills/trashcompact')), false);
});
