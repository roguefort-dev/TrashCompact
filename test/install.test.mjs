import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'trashcompact-install-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, "checkout with ' quotes");
  cpSync(join(root, 'install'), join(repo, 'install'), { recursive: true });
  mkdirSync(join(repo, 'skill')); writeFileSync(join(repo, 'skill/SKILL.md'), 'skill');
  mkdirSync(join(home, '.codex'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude/settings.json'), 'untouched');
  const settings = join(home, '.codex/hooks.json');
  const run = (script, ...args) => spawnSync(process.execPath, [join(repo, 'install', script), ...args], { env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex') }, encoding: 'utf8' });
  return { home, repo, settings, run };
}
test('configure preserves unrelated mixed hooks and quotes command paths', t => {
  const f = fixture(t);
  const unrelated = { type: 'command', command: 'echo trashcompact-hook' };
  writeFileSync(f.settings, JSON.stringify({ hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: `${f.repo}/bin/trashcompact-hook stop` }, { type: 'command', command: "'" + `${f.repo}/bin/trashcompact-hook`.replaceAll("'", "'\"'\"'") + "' stop" }, unrelated] }] }, arbitrary: 42 }), { mode: 0o600 });
  assert.equal(f.run('configure.mjs').status, 0);
  let settings = JSON.parse(readFileSync(f.settings));
  assert.deepEqual(settings.hooks.Stop[0], { matcher: 'x', hooks: [unrelated] });
  assert.equal(settings.arbitrary, 42);
  assert.equal(settings.hooks.SessionStart[0].matcher, '^compact$');
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[1].hooks[0].async, true);
  assert.equal(settings.hooks.Stop[1].hooks[0].timeout, 120);
  assert.match(settings.hooks.Stop[1].hooks[0].command, /^'.*' stop$/);
  assert.equal(settings.hooks.PreCompact[0].hooks[0].async, undefined);
  assert.equal(settings.hooks.PreCompact[0].hooks[0].timeout, 65);
  assert.equal(readFileSync(join(f.home, '.claude/settings.json'), 'utf8'), 'untouched');
  assert.match(settings.hooks.PreCompact[0].hooks[0].command, /^'.*' precompact$/);
  assert.equal(statSync(f.settings).mode & 0o777, 0o600);
  assert.equal(f.run('configure.mjs').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.settings)), settings);
  assert.equal(f.run('configure.mjs', '--remove').status, 0);
  settings = JSON.parse(readFileSync(f.settings));
  assert.equal(settings.hooks.Stop.length, 1); assert.equal(settings.hooks.PreCompact, undefined);
  assert.equal(settings.hooks.SessionStart, undefined);
});
test('malformed settings are not rewritten', t => {
  const f = fixture(t); writeFileSync(f.settings, '{broken');
  assert.notEqual(f.run('configure.mjs').status, 0); assert.equal(readFileSync(f.settings, 'utf8'), '{broken');
});
test('skill management preserves real directories and removes only own links', t => {
  const f = fixture(t);
  const existing = join(f.home, '.agents/skills/trashcompact');
  mkdirSync(existing, { recursive: true }); writeFileSync(join(existing, 'user-data'), 'keep');
  assert.equal(f.run('skills.mjs').status, 0);
  assert.equal(f.run('skills.mjs', '--remove').status, 0);
  assert.equal(readFileSync(join(existing, 'user-data'), 'utf8'), 'keep');
  assert.equal(existsSync(join(f.home, '.claude/skills/trashcompact')), false);
  assert.equal(existsSync(join(f.home, '.codex/skills/trashcompact')), false);
});

test('Claude install merges only owned hooks and leaves Codex unchanged', t => {
  const f = fixture(t), path = join(f.home, '.claude/settings.json');
  writeFileSync(path, JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } }));
  writeFileSync(f.settings, '{"untouched":true}');
  assert.equal(f.run('configure.mjs', '--target', 'claude').status, 0);
  const value = JSON.parse(readFileSync(path));
  assert.deepEqual(value.permissions, { allow: ['Read'] });
  assert.equal(value.hooks.Stop.length, 2);
  assert.equal(value.hooks.Stop[1].hooks[0].async, true);
  for (const event of ['Stop', 'PreCompact', 'SessionStart']) {
    const hook = value.hooks[event].at(-1).hooks[0];
    assert.match(hook.command, new RegExp(`claude-${event.toLowerCase()}$`));
    assert.equal(hook.statusMessage, undefined); assert.equal(hook.additionalContextLimit, undefined);
  }
  assert.equal(f.run('configure.mjs', '--target', 'claude').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(path)), value);
  assert.equal(readFileSync(f.settings, 'utf8'), '{"untouched":true}');
  assert.equal(f.run('configure.mjs', '--target', 'claude', '--remove').status, 0);
  assert.equal(JSON.parse(readFileSync(path)).hooks.Stop[0].hooks[0].command, 'echo existing');
});
test('target skill links are isolated and unsupported helper flags are rejected', t => {
  const f = fixture(t);
  assert.equal(f.run('skills.mjs', '--target', 'claude').status, 0);
  assert.ok(existsSync(join(f.home, '.claude/skills/trashcompact')));
  assert.equal(existsSync(join(f.home, '.codex/skills/trashcompact')), false);
  assert.equal(f.run('skills.mjs', '--target', 'codex', '--remove').status, 0);
  assert.ok(existsSync(join(f.home, '.claude/skills/trashcompact')));
  assert.notEqual(f.run('configure.mjs', '--surprise').status, 0);
  assert.notEqual(f.run('skills.mjs', '--target', 'unknown').status, 0);
});
test('installer help and argument validation precede dependency installation', () => {
  for (const [args, code] of [[['--help'], 0], [['--unknown'], 2], [['--target', 'unknown'], 2]]) {
    const result = spawnSync(process.execPath, [join(root, 'install.mjs'), ...args], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.equal(result.status, code);
  }
});
test('OpenCode targets share the documented skill directory and remove only the owned link', t => {
  const f = fixture(t), shared = join(f.home, '.config/opencode/skills/trashcompact');
  const env = { ...process.env, HOME: f.home, XDG_CONFIG_HOME: join(f.home, '.config') };
  const run = (...args) => spawnSync(process.execPath, [join(f.repo, 'install/skills.mjs'), ...args], { env, encoding: 'utf8' });
  assert.equal(run('--target', 'opencode').status, 0); assert.ok(existsSync(shared));
  assert.equal(run('--target', 'opencode2').status, 0); assert.ok(existsSync(shared));
  assert.equal(existsSync(join(f.home, '.config/opencode2')), false);
  assert.equal(run('--target', 'opencode2', '--remove').status, 0); assert.equal(existsSync(shared), false);
});
