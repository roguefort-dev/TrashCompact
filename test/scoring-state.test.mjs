import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openState, saveState, loadState, completeCompaction, nativeEpoch } from '../src/scoring-state.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trashcompact-generation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'scores.json');
}
test('completion clears prose and recovery, fences in-flight Stop, and preserves rebuilt scores on duplicates', t => {
  const path = fixture(t), old = openState(path, 'before');
  old.verdicts.old = { retention: { score: 2, confidence: 1 } };
  old.recoveryRank = { passages: { old: {} }, relations: { old: {} } };
  saveState(path, old);
  completeCompaction(path, 'after', 'boundary-1');
  assert.deepEqual(loadState(path).verdicts, {});
  assert.equal(loadState(path).recoveryRank, undefined);
  const next = openState(path, 'after');
  next.verdicts.new = { retention: { score: 1, confidence: 1 } };
  saveState(path, next);
  const before = readFileSync(path, 'utf8');
  assert.throws(() => saveState(path, old), /changed after native compaction/);
  assert.equal(readFileSync(path, 'utf8'), before);
  completeCompaction(path, 'after', 'boundary-1');
  assert.deepEqual(loadState(path).verdicts, next.verdicts);
});
test('marker fallback rebuild before SessionStart is retained and a markerless completion clears once', t => {
  const path = fixture(t);
  const state = openState(path, 'new-marker'); state.verdicts.fresh = {}; saveState(path, state);
  completeCompaction(path, 'new-marker', 'new-marker');
  assert.deepEqual(loadState(path).verdicts, state.verdicts);
  completeCompaction(path, 'new-marker', 'prepared-boundary', false);
  assert.deepEqual(loadState(path).verdicts, {});
  const rebuilt = openState(path, 'new-marker'); rebuilt.verdicts.rebuilt = {}; saveState(path, rebuilt);
  completeCompaction(path, 'new-marker', 'prepared-boundary', false);
  assert.deepEqual(loadState(path).verdicts, rebuilt.verdicts);
});
test('legacy unbound cache expires once; offline mismatch does not alter it', t => {
  const path = fixture(t);
  writeFileSync(path, JSON.stringify({ version: 2, verdicts: { stale: {} } }));
  const before = readFileSync(path, 'utf8');
  assert.deepEqual(openState(path, 'epoch', true).verdicts, {});
  assert.equal(readFileSync(path, 'utf8'), before);
  const fresh = openState(path, 'epoch');
  assert.deepEqual(fresh.verdicts, {});
  assert.equal(openState(path, 'epoch').generation, fresh.generation);
});
test('epoch changes only with native boundary content, including Claude summaries', () => {
  for (const [format, marker] of [['codex', { type: 'compacted', payload: { message: 'summary' } }], ['claude', { type: 'assistant', isCompactSummary: true, message: { content: 'summary' } }]]) {
    const epoch = nativeEpoch([marker], format);
    assert.equal(nativeEpoch([marker, { type: 'user', text: 'new turn' }], format), epoch);
    assert.notEqual(nativeEpoch([{ ...marker, uuid: 'rewritten' }], format), epoch);
  }
});
test('a stale transcript read cannot initialize over a newer cache or complete over it', t => {
  const path = fixture(t), snapshot = openState(path, 'before');
  const next = openState(path, 'after'); next.verdicts.new = {}; saveState(path, next);
  const before = readFileSync(path, 'utf8');
  assert.throws(() => openState(path, 'before', false, snapshot), /changed while reading/);
  assert.throws(() => completeCompaction(path, 'before', 'late-event', false, snapshot), /changed while reading/);
  assert.equal(readFileSync(path, 'utf8'), before);
});
