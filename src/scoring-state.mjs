import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Boundaries expire judgments, but never identify which archive records remain live.
export function nativeEpoch(entries, format) {
  const markers = entries.filter(entry => format === 'codex' ? entry.type === 'compacted' :
    entry.type === 'system' && entry.subtype === 'compact_boundary' || entry.isCompactSummary === true);
  return createHash('sha256').update(JSON.stringify([format, markers])).digest('hex');
}

export function loadState(path) {
  const empty = { version: 2, anchor: null, verdicts: {}, usage: { requests: 0, input: 0 }, runs: 0 };
  if (!path || !existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed?.version === 2 && parsed.verdicts && typeof parsed.verdicts === "object" && !Array.isArray(parsed.verdicts)
      ? { ...empty, ...parsed } : empty;
  } catch { return empty; }
}

// Lock only the read/merge/rename transaction, never the remote request. A competing
// writer fails safely without overwriting its cache. A stale lock requires removal.
export function saveState(path, state, delta = { requests: 0, input: 0 }, runs = 1) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  try { mkdirSync(lock); } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Cache is locked by another writer: ${path}`);
    throw error;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const current = loadState(path);
    if (current.generation !== state.generation) throw new Error('Scoring cache changed after native compaction; retry with the current transcript.');
    const counter = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
    const mergeVerdicts = name => {
      const newer = state[name], older = current[name];
      if (!newer) return older;
      return { version: newer.version, verdicts: { ...(older?.version === newer.version ? older.verdicts : {}), ...newer.verdicts } };
    };
    const merged = { ...state, verdicts: { ...current.verdicts, ...state.verdicts },
      relevance: mergeVerdicts("relevance"), taskGroups: mergeVerdicts("taskGroups"),
      recoveryRank: { version: 1,
        passages: { ...current.recoveryRank?.passages, ...state.recoveryRank?.passages },
        relations: { ...current.recoveryRank?.relations, ...state.recoveryRank?.relations } },
      runs: counter(current.runs) + runs,
      usage: { requests: counter(current.usage?.requests) + counter(delta.requests), input: counter(current.usage?.input) + counter(delta.input), output: counter(current.usage?.output) + counter(delta.output) } };
    writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

function replaceState(path, operation) {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`, temporary = `${path}.${randomUUID()}.tmp`;
  try { mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Cache is locked by another writer: ${path}`);
    throw error;
  }
  try {
    const state = operation(loadState(path));
    writeFileSync(temporary, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    return state;
  } finally { rmSync(temporary, { force: true }); rmSync(lock, { recursive: true, force: true }); }
}
const fresh = (epoch, completion) => ({ version: 2, epoch, generation: randomUUID(),
  ...(completion && { completion }), anchor: null, verdicts: {}, usage: { requests: 0, input: 0 }, runs: 0 });

export function openState(path, epoch, readonly = false, expected) {
  const state = loadState(path);
  if (expected && state.generation !== expected.generation) {
    if (readonly) return fresh(epoch);
    throw new Error('Scoring cache changed while reading the transcript; retry.');
  }
  if (state.generation && state.epoch === epoch) return state;
  if (readonly) return fresh(epoch);
  return replaceState(path, current => {
    if (expected && current.generation !== expected.generation)
      throw new Error('Scoring cache changed while reading the transcript; retry.');
    return current.generation && current.epoch === epoch ? current : fresh(epoch);
  });
}

// Keep a generation tombstone so a Stop request begun before compaction cannot
// merge its old snapshot over newer judgments. Duplicate completion is harmless.
export function completeCompaction(path, epoch, completion, hasMarker = true, expected) {
  return replaceState(path, current => {
    if (current.completion === completion) return current;
    if (expected && current.generation !== expected.generation)
      throw new Error('Scoring cache changed while reading the transcript; retry.');
    // A CLI/Stop pass may already have observed the new native marker.
    if (hasMarker && current.generation && current.epoch === epoch)
      return { ...current, completion };
    return fresh(epoch, completion);
  });
}
