import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hookFlags } from '../hooks/common.mjs';

const root = resolve(import.meta.dirname, '..');
function fixture(t, launcher) {
  const dir = mkdtempSync(join(tmpdir(), 'trashcompact-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'hooks'), join(dir, 'hooks'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  if (launcher) writeFileSync(join(dir, 'bin/trashcompact'), '#!/bin/sh\n' + launcher, { mode: 0o700 });
  return dir;
}
function run(dir, mode, input, flags = '') {
  return spawnSync(process.execPath, [join(dir, `hooks/on-${mode}.mjs`)], { input, encoding: 'utf8', env: { ...process.env, HOME: dir, CODEX_HOME: join(dir, '.codex'), TRASHCOMPACT_FLAGS: flags } });
}
test('literal hook flags accept quoted values and reject action flags', () => {
  assert.deepEqual(hookFlags('--state "/tmp/a b" --keep-tail 40'), ['--state', '/tmp/a b', '--keep-tail', '40']);
  for (const flag of ['--self-test', '--update', '--full-log', '--out x', '--plan', '--format claude', '--recovery', '--state "broken']) assert.throws(() => hookFlags(flag));
});
test('malformed hook input and unavailable launcher silently fail open', t => {
  const dir = fixture(t);
  for (const mode of ['stop', 'precompact', 'sessionstart']) for (const input of ['{', 'null', '{"transcript_path":3}', '{"transcript_path":"/tmp/log"}']) {
    const result = run(dir, mode, input);
    assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});
test('launcher treats credentials as literal and offline does not read env files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'trashcompact-launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'bin'), join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/filter-transcript.mjs'), 'console.log(process.env.TYPESAFE_API_KEY || "offline")');
  const keyFile = join(dir, 'env');
  const env = { ...process.env, HOME: dir, TYPESAFE_API_KEY: '', TRASHCOMPACT_ENV: keyFile };
  const launch = args => spawnSync(process.execPath, [join(dir, 'bin/launch.mjs'), ...args], { env, encoding: 'utf8' });
  writeFileSync(keyFile, 'export TYPESAFE_API_KEY="synthetic-key"\n');
  assert.equal(launch([]).stdout, 'synthetic-key\n');
  writeFileSync(keyFile, 'TYPESAFE_API_KEY=$(echo secret)\n');
  const result = launch([]); assert.equal(result.status, 1); assert.doesNotMatch(result.stderr, /secret/);
  rmSync(keyFile); mkdirSync(keyFile);
  for (const mode of ['--precompact', '--plan', '--offline', '--recovery']) assert.equal(launch([mode]).stdout, 'offline\n');
});
