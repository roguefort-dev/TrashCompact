import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const message = text => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const transcript = (count = 3) => Array.from({ length: count }, (_, i) => JSON.stringify(message(`Synthetic diagnosis ${i}: preserve contract ${i}.`))).join('\n') + '\n';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trashcompact-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(resolve('src'), join(dir, 'src'), { recursive: true });
  const pkg = join(dir, 'node_modules/@typesafe-ai/sdk');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
  writeFileSync(join(pkg, 'index.mjs'), `
    import { appendFileSync, mkdirSync } from 'node:fs';
    export const score = () => ({ kind: 'score' });
    export const choice = () => ({ kind: 'choice' });
    let calls = 0;
    export class TypeSafeClient { async systemOne(request) {
      calls++;
      appendFileSync(process.env.AUDIT, JSON.stringify(request) + '\\n');
      if (calls === Number(process.env.FAIL_AT)) throw new Error('secret mock server body');
      if (calls === Number(process.env.KILL_AT)) process.kill(process.pid, 'SIGKILL');
      if (process.env.LOCK_AFTER) mkdirSync(process.env.LOCK_AFTER);
      return { answers: Object.fromEntries(Object.entries(request.questions).map(([key,q]) =>
        [key, q.kind === 'score' ? { score: 2, confidence: 1 } : { choice: 'uncertain', confidence: 1 }])),
        usage: { input_tokens: 10, output_tokens: 3 } };
    }}
  `);
  const audit = join(dir, 'audit'), cacheHome = join(dir, '.codex', 'trashcompact');
  const run = (raw, args = [], env = {}) => spawnSync(process.execPath,
    [join(dir, 'src/filter-transcript.mjs'), '-', '--keep-tail', '0', '--batch', '1', ...args],
    { input: raw, encoding: 'utf8', env: { ...process.env, HOME: dir, CODEX_HOME: join(dir, '.codex'),
      TYPESAFE_API_KEY: 'synthetic', AUDIT: audit, ...env } });
  const cachePath = raw => join(cacheHome, `stdin-${createHash('sha256').update(raw).digest('hex')}.json`);
  const requests = () => existsSync(audit) ? readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { dir, run, cachePath, requests, cacheHome };
}

test('stdin scores persist by default, reuse exact input and isolate different input', t => {
  const f = fixture(t), raw = transcript();
  let result = f.run(raw); assert.equal(result.status, 0, result.stderr);
  assert.equal(f.requests().length, 3);
  result = f.run(raw, ['--update']); assert.equal(result.status, 0, result.stderr);
  assert.equal(f.requests().length, 3);
  const changed = raw.replace('contract 0', 'contract 99');
  result = f.run(changed); assert.equal(result.status, 0, result.stderr);
  assert.equal(f.requests().length, 6);
  assert.equal(readdirSync(f.cacheHome).length, 2);
  const cache = JSON.parse(readFileSync(f.cachePath(raw)));
  assert.equal(cache.runs, 2); assert.deepEqual(cache.usage, { requests: 3, input: 30, output: 9 });
  assert.ok(!JSON.stringify(cache).includes('Synthetic diagnosis'));
});

for (const failure of ['FAIL_AT', 'KILL_AT']) test(`completed prose batches survive ${failure} and restart without repeated scoring`, t => {
  const f = fixture(t), raw = transcript();
  const failed = f.run(raw, ['--update'], { [failure]: '2' });
  assert.notEqual(failed.status, 0); assert.ok(!failed.stderr.includes('secret mock server body'));
  let cache = JSON.parse(readFileSync(f.cachePath(raw)));
  assert.equal(Object.keys(cache.verdicts).length, 1);
  assert.equal(cache.runs, 1); assert.deepEqual(cache.usage, { requests: 1, input: 10, output: 3 });
  const resumed = f.run(raw, ['--update']); assert.equal(resumed.status, 0, resumed.stderr);
  const retried = f.requests().slice(2);
  assert.equal(retried.length, 2);
  assert.ok(retried.every(request => !JSON.stringify(request).includes('Synthetic diagnosis 0')));
  cache = JSON.parse(readFileSync(f.cachePath(raw)));
  assert.equal(cache.runs, 2); assert.deepEqual(cache.usage, { requests: 3, input: 30, output: 9 });
});

test('ranking checkpoint survives failure and preserves earlier prose judgments', t => {
  const f = fixture(t), raw = transcript(10);
  // Ten prose batches, then one ranking batch succeeds and the second fails.
  const failed = f.run(raw, ['--update', '--recovery-rank'], { FAIL_AT: '12' });
  assert.equal(failed.status, 1, failed.stderr);
  let cache = JSON.parse(readFileSync(f.cachePath(raw)));
  assert.equal(Object.keys(cache.verdicts).length, 10);
  assert.equal(Object.keys(cache.recoveryRank.passages).length, 8);
  assert.deepEqual(cache.usage, { requests: 11, input: 110, output: 33 });
  const firstRanking = f.requests()[10];
  const resumed = f.run(raw, ['--update', '--recovery-rank']); assert.equal(resumed.status, 0, resumed.stderr);
  const retried = f.requests().slice(12);
  assert.equal(retried.length, 1);
  const oldTexts = Object.values(firstRanking.state.items).map(item => item.passage.text);
  assert.ok(Object.values(retried[0].state.items).every(item => !oldTexts.includes(item.passage.text)));
  cache = JSON.parse(readFileSync(f.cachePath(raw)));
  assert.equal(cache.runs, 2); assert.deepEqual(cache.usage, { requests: 12, input: 120, output: 36 });
});

test('cache write failures stop paid requests before startup and between batches', t => {
  const f = fixture(t), raw = transcript(), path = f.cachePath(raw);
  mkdirSync(`${path}.lock`, { recursive: true });
  let result = f.run(raw); assert.equal(result.status, 1); assert.equal(f.requests().length, 0);
  rmSync(`${path}.lock`, { recursive: true });
  result = f.run(raw, [], { LOCK_AFTER: `${path}.lock` });
  assert.equal(result.status, 1); assert.equal(f.requests().length, 1);
});

test('offline modes neither request scores nor create caches, and stdin output cannot alias its cache', t => {
  const f = fixture(t), raw = transcript();
  for (const mode of ['--offline', '--plan', '--precompact', '--recovery']) {
    const result = f.run(raw, [mode, '--recovery-rank']); assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(f.requests().length, 0); assert.ok(!existsSync(f.cacheHome));
  const collision = f.run(raw, ['--out', f.cachePath(raw)]);
  assert.equal(collision.status, 1); assert.match(collision.stderr, /must be different files/);
  assert.equal(f.requests().length, 0); assert.ok(!existsSync(f.cacheHome));
});

test('explicit state reuses scores as stdin grows', t => {
  const f = fixture(t), state = join(f.dir, 'chosen.json');
  let result = f.run(transcript(2), ['--state', state]); assert.equal(result.status, 0, result.stderr);
  result = f.run(transcript(3), ['--state', state]); assert.equal(result.status, 0, result.stderr);
  assert.equal(f.requests().length, 3); assert.ok(!existsSync(f.cacheHome));
});

for (const format of ['codex', 'claude']) test(`${format} native boundaries expire scores, while appends and rewritten IDs require content matches`, t => {
  const f = fixture(t), state = join(f.dir, 'session.json');
  const encode = entries => entries.map(JSON.stringify).join('\n') + '\n';
  const entry = text => format === 'codex' ? message(text) : { type: 'assistant', uuid: 'same-id', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  const original = [entry('Preserve the original contract.')];
  const run = entries => f.run(encode(entries), ['--state', state, '--format', format, '--update']);
  assert.equal(run(original).status, 0);
  assert.equal(run(original).status, 0);
  assert.equal(f.requests().length, 1);
  const marker = format === 'codex' ? { type: 'compacted', payload: { message: 'Native summary' } } :
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary-1' };
  const compacted = [...original, marker];
  const before = readFileSync(state, 'utf8');
  const offline = f.run(encode(compacted), ['--state', state, '--format', format, '--plan']);
  assert.equal(offline.status, 0, offline.stderr);
  assert.match(offline.stdout, /cached verdicts  0 reused/);
  assert.equal(readFileSync(state, 'utf8'), before);
  assert.equal(run(compacted).status, 0);
  assert.equal(f.requests().length, 2);
  assert.equal(run([...compacted, entry('Preserve the new contract.')]).status, 0);
  assert.equal(f.requests().length, 3);
  assert.equal(run([entry('Rewritten contract under the same ID.'), marker]).status, 0);
  assert.equal(f.requests().length, 4);
});
