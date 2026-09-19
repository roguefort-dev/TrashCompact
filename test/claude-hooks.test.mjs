import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadRecords } from '../src/filter-transcript.mjs';
import { prepareRecoveryRanking } from '../src/recovery-rank.mjs';
const root = resolve(import.meta.dirname, '..');
const msg = (type, content, extra = {}) => ({ type, message: { role: type, content }, ...extra });
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'trashcompact-claude-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const dir of ['hooks', 'bin', 'src']) cpSync(join(root, dir), join(home, dir), { recursive: true });
  const transcript = join(home, 'conversation.jsonl');
  writeFileSync(transcript, [msg('user', 'Keep the API contract stable. Pending: repair cache.'), msg('assistant', [{ type: 'text', text: 'Diagnosis: cache identity mismatch remains unresolved.' }])].map(JSON.stringify).join('\n') + '\n');
  const run = (mode, overrides = {}) => spawnSync(process.execPath, [join(home, `hooks/claude-on-${mode}.mjs`)], { input: JSON.stringify({ session_id: 'claude-session', transcript_path: transcript, source: 'compact', ...overrides }), encoding: 'utf8', env: { ...process.env, HOME: home, CODEX_HOME: join(home, 'custom-codex'), TRASHCOMPACT_ENV: join(home, 'missing'), TYPESAFE_API_KEY: '', TRASHCOMPACT_FLAGS: '' } });
  return { home, transcript, run };
}
test('Claude lifecycle uses isolated caches, remains quiet and delivers recovery once', t => {
  const f = fixture(t);
  const pre = f.run('precompact'); assert.equal(pre.status, 0); assert.equal(pre.stdout, ''); assert.equal(pre.stderr, '');
  const path = join(f.home, '.claude/trashcompact/recovery'); assert.equal(readdirSync(path).length, 1);
  assert.equal(existsSync(join(f.home, 'custom-codex/trashcompact')), false);
  assert.equal(f.run('sessionstart', { source: 'startup' }).stdout, '');
  const context = JSON.parse(f.run('sessionstart').stdout).hookSpecificOutput;
  assert.equal(context.hookEventName, 'SessionStart');
  assert.match(context.additionalContext, /Pending: repair cache/); assert.match(context.additionalContext, /cache identity mismatch/);
  assert.match(context.additionalContext, /"role":"user"/); assert.ok(Buffer.byteLength(context.additionalContext) <= 6000);
  assert.equal(f.run('sessionstart').stdout, '');
});
test('Claude Stop always uses Claude format and a separate state path', t => {
  const f = fixture(t), audit = join(f.home, 'args.json');
  writeFileSync(join(f.home, 'bin/launch.mjs'), `#!${process.execPath}\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(audit)},JSON.stringify(process.argv.slice(2)));`, { mode: 0o700 });
  assert.equal(f.run('stop').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(audit)), [f.transcript, '--state', join(f.home, '.claude/trashcompact', createHash('sha256').update(f.transcript).digest('hex') + '.json'), '--format', 'claude', '--update']);
});
test('Claude recovery attributes plain tool results correctly and excludes hidden or mixed data', t => {
  const f = fixture(t);
  const entries = [msg('user', 'A real user request'), msg('assistant', 'Visible assistant diagnosis'),
    msg('user', [{ type: 'tool_result', tool_use_id: 'call', content: 'Tool failure evidence' }]),
    msg('assistant', [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: 'MIXED_HIDDEN' }]),
    msg('user', [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'image', source: { data: 'OPAQUE_IMAGE' } }] }]),
    msg('user', 'PRIVATE_SIDECHAIN', { isSidechain: true }), msg('assistant', 'PRIVATE_META', { isMeta: true }),
    { type: 'unknown', message: { content: 'UNKNOWN_SCHEMA' } }];
  writeFileSync(f.transcript, entries.map(JSON.stringify).join('\n'));
  const { records } = loadRecords(f.transcript, { format: 'claude' });
  assert.equal(records[2].role, 'tool'); assert.equal(records[0].role, 'user');
  const ranking = prepareRecoveryRanking(records, {}); const sent = JSON.stringify(ranking);
  assert.ok(sent.includes('Visible assistant diagnosis')); assert.ok(!sent.includes('Tool failure evidence'));
  assert.equal(ranking.query, 'A real user request');
  for (const excluded of ['PRIVATE_THINKING', 'MIXED_HIDDEN', 'OPAQUE_IMAGE', 'PRIVATE_SIDECHAIN', 'PRIVATE_META', 'UNKNOWN_SCHEMA']) assert.ok(!sent.includes(excluded));
  f.run('precompact'); const output = f.run('sessionstart').stdout;
  assert.ok(output.includes('Tool failure evidence'));
  for (const excluded of ['PRIVATE_THINKING', 'MIXED_HIDDEN', 'OPAQUE_IMAGE', 'PRIVATE_SIDECHAIN', 'PRIVATE_META', 'UNKNOWN_SCHEMA']) assert.ok(!output.includes(excluded));
});
