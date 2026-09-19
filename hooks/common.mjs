import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, realpath, stat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';

// A small literal tokenizer: quotes group values; nothing is evaluated or expanded.
export function splitFlags(raw) {
  const tokens = []; let token = '', quote = null, started = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && quote !== "'") {
      if (++i === raw.length) throw new Error('Incomplete escape');
      token += raw[i]; started = true;
    } else if (quote) {
      if (c === quote) quote = null; else token += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) tokens.push(token); token = ''; started = false; }
    else { token += c; started = true; }
  }
  if (quote) throw new Error('Unclosed quote');
  if (started) tokens.push(token);
  return tokens;
}

export function hookFlags(raw) {
  const args = splitFlags(raw);
  const allowed = new Set(['--keep-tail', '--threshold', '--min-confidence', '--batch', '--chars', '--model', '--state']);
  for (let i = 0; i < args.length;) {
    if (args[i] === '--recovery-rank' || args[i] === '--relevance') { i++; continue; }
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unsupported hook flag');
    i += 2;
  }
  return args;
}

// PreCompact plain stdout is ignored by Codex. Stage a private, single-use note for
// SessionStart(compact), the lifecycle event that can add model context.
const MAX_NOTE_BYTES = 6000;
const digest = value => createHash('sha256').update(value).digest('hex');
const configurationFor = flags => digest(JSON.stringify({ lifecycle: 4, flags }));
const isMarker = (record, format) => format === 'codex' ? record.entry.type === 'compacted' :
  record.entry.type === 'system' && record.entry.subtype === 'compact_boundary' || record.entry.isCompactSummary === true;
function matchesBoundary(snapshot, bytes, records, epoch, configuration, format) {
  return snapshot?.configuration === configuration && Number.isSafeInteger(snapshot.bytes) && snapshot.bytes >= 0 &&
    Number.isSafeInteger(snapshot.markers) && snapshot.markers >= 0 &&
    records.filter(record => isMarker(record, format)).length >= snapshot.markers &&
    snapshot.bytes <= bytes.length && digest(bytes.subarray(0, snapshot.bytes)) === snapshot.boundary &&
    records.filter(record => isMarker(record, format)).length - snapshot.markers <= 1 &&
    (snapshot.completedEpoch == null || snapshot.completedEpoch === epoch);
}
function validSnapshot(snapshot, identity) {
  return typeof snapshot?.note === 'string' && snapshot.note.startsWith('[TrashCompact recovery context]') &&
    JSON.stringify(snapshot.identity) === JSON.stringify(identity) && Buffer.byteLength(snapshot.note) <= MAX_NOTE_BYTES;
}
async function deliverContext(note) {
  await new Promise((resolve, reject) => {
    const failed = error => reject(error);
    process.stdout.once('error', failed);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } }) + '\n', error => {
      if (error) reject(error);
      else { process.stdout.removeListener('error', failed); resolve(); }
    });
  });
}
async function readState(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}
async function atomicState(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export function runCli(args, timeoutMs = 25000, launcher = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'launch.mjs')) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [launcher, ...args], { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    const chunks = []; let bytes = 0, failed = false;
    let forceKill;
    const terminate = () => {
      failed = true;
      const signal = name => {
        try {
          if (process.platform === 'win32' && child.pid) {
            // The launcher has a filter child; kill the whole tree at the deadline.
            const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
            killer.on('error', () => { try { child.kill(name); } catch {} });
          } else if (child.pid) process.kill(-child.pid, name);
          else child.kill(name);
        } catch {}
      };
      signal('SIGTERM');
      forceKill ??= setTimeout(() => { signal('SIGKILL'); resolve(null); },1000);
    };
    const timeout = setTimeout(terminate, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { terminate(); }
      else chunks.push(chunk);
    });
    child.on('error', () => { clearTimeout(timeout); clearTimeout(forceKill); resolve(null); });
    child.on('close', code => {
      clearTimeout(timeout); clearTimeout(forceKill);
      resolve(code === 0 && !failed ? Buffer.concat(chunks).toString('utf8') : null);
    });
  });
}

export async function runHook(mode, { format = 'codex' } = {}) {
  let lock;
  try {
    const { completeCompaction, loadState: loadScoringState } = await import('../src/scoring-state.mjs');
    const { loadRecords, parseArguments } = await import('../src/filter-transcript.mjs');
    process.stdin.setEncoding('utf8');
    let raw = '';
    for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) return; }
    const input = JSON.parse(raw || '{}');
    if (!input || input.agent_id != null || typeof input.session_id !== 'string' || !input.session_id.trim()) return;
    if (mode === 'sessionstart' && input.source !== 'compact') return;
    if (mode === 'stop' && input.stop_hook_active) return;
    const stateHome = format === 'claude' ? join(process.env.HOME || homedir(), '.claude', 'trashcompact') : join(process.env.CODEX_HOME || join(process.env.HOME || homedir(), '.codex'), 'trashcompact');
    const stateFlags = transcript => format === 'claude' && !hookFlags(process.env.TRASHCOMPACT_FLAGS ?? '').includes('--state') ? ['--state', join(stateHome, `${digest(transcript)}.json`)] : [];
    const pendingPath = join(stateHome, 'recovery', `${digest(input.session_id)}.json`);
    const reconcile = async (transcript, pending) => {
      if (!pending) return;
      const extra = hookFlags(process.env.TRASHCOMPACT_FLAGS ?? '');
      const options = parseArguments([transcript, ...extra, ...stateFlags(transcript), '--format', format]);
      const target = pending.state ?? options.state;
      const initialState = loadScoringState(target);
      if (initialState.completion === pending.completion) return;
      const { epoch } = loadRecords(transcript, { format });
      completeCompaction(target, epoch, pending.completion,
        pending.hasMarker || epoch !== pending.epoch, initialState);
    };
    if (mode === 'stop') {
      if (typeof input.transcript_path !== 'string' || !input.transcript_path.trim()) return;
      const transcript = await realpath(resolve(input.transcript_path));
      await reconcile(transcript, (await readState(pendingPath))?.pending);
      const extra = hookFlags(process.env.TRASHCOMPACT_FLAGS ?? '');
      await runCli([transcript, ...extra, ...stateFlags(transcript), '--format', format, '--update'], 110000);
      return;
    }
    const cache = join(stateHome, 'recovery');
    await mkdir(cache, { recursive: true, mode: 0o700 });
    await chmod(cache, 0o700);
    const path = join(cache, `${digest(input.session_id)}.json`);
    // Concurrent duplicate boundaries must not overwrite or emit the same note.
    const lockPath = `${path}.lock`;
    try { await mkdir(lockPath, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() - (await stat(lockPath)).mtimeMs < 120000) return;
      // Recover locks left by a terminated hook; live preparation is bounded below the 65s hook timeout.
      await rm(lockPath, { recursive: true, force: true });
      await mkdir(lockPath, { mode: 0o700 });
    }
    lock = lockPath;
    const previous = await readState(path);
    if (mode === 'precompact' || mode === 'sessionstart' || mode === 'postcompact') {
      // Invalidate before any operation that can fail, including path resolution,
      // flags, child execution, or checking a changed transcript identity.
      await atomicState(path, { boundary: previous?.boundary, epoch: previous?.epoch, pending: previous?.pending });
    }
    if (typeof input.transcript_path !== 'string' || !input.transcript_path.trim()) return;
    const transcript = await realpath(resolve(input.transcript_path));
    const info = await stat(transcript);
    const identity = { session: input.session_id, transcript, dev: info.dev, ino: info.ino };
    if (mode === 'sessionstart' || mode === 'postcompact') {
      const extra = hookFlags(process.env.TRASHCOMPACT_FLAGS ?? '');
      const options = parseArguments([transcript, ...extra, ...stateFlags(transcript), '--format', format]);
      const initialState = loadScoringState(options.state);
      const { epoch, records } = loadRecords(transcript, { format });
      const hasMarker = records.some(record => isMarker(record, format));
      const completion = digest(JSON.stringify([epoch, previous?.boundary ?? (hasMarker ? epoch : digest(await readFile(transcript)))]));
      const pending = { state: options.state, epoch, completion, hasMarker: hasMarker && previous?.epoch !== epoch };
      // Persist the reset obligation before trying the short cache transaction.
      // A contending Stop must reconcile it before reusing any judgments.
      await atomicState(path, { boundary: previous?.boundary, epoch: previous?.epoch, pending });
      try { completeCompaction(options.state, epoch, completion, pending.hasMarker, initialState); }
      catch { /* Keep the pending reset for the next hook, but still deliver the note. */ }
      if (!validSnapshot(previous, identity) ||
          !matchesBoundary(previous, await readFile(transcript), records, epoch, configurationFor(extra), format)) return;
      if (mode === 'postcompact') {
        // PostCompact cannot inject model context. Bind and retain the note until
        // SessionStart(compact) runs before the next model request.
        await atomicState(path, { ...previous, pending, completedEpoch: epoch });
        return;
      }
      await deliverContext(previous.note);
      return;
    }
    const extra = hookFlags(process.env.TRASHCOMPACT_FLAGS ?? '');
    if (mode !== 'precompact') return;
    await reconcile(transcript, previous?.pending);
    const transcriptBytes = await readFile(transcript);
    const boundary = digest(transcriptBytes);
    const configuration = configurationFor(extra);
    if (previous?.boundary === boundary) {
      // A duplicate before consumption keeps the exact pending note. We still
      // invalidate first so invalid paths or flags cannot retain stale context.
      if (!previous.note) return; // Already consumed or a prior refresh failed.
      if (previous.configuration === configuration) {
        if (validSnapshot(previous, identity)) await atomicState(path, previous);
        return;
      }
      // Changed valid flags require a fresh successful render, never reuse.
    }
    // Remember attempted boundaries too: a failed refresh cannot revive an old note.
    const { epoch, records } = loadRecords(transcript, { format });
    const markers = records.filter(record => isMarker(record, format)).length;
    await atomicState(path, { boundary, epoch });
    const rankingFlags = extra.filter(flag => flag !== '--recovery-rank');
    // This synchronous pre-pass runs only at a real compaction boundary. Failure
    // or timeout leaves compaction free to continue with an offline fallback.
    await runCli([transcript, ...rankingFlags, ...stateFlags(transcript), '--format', format, '--update', '--recovery-rank'],45000);
    const note = await runCli([transcript, ...rankingFlags, ...stateFlags(transcript), '--format', format, '--recovery', '--recovery-rank', '--offline'],10000);
    if (!note?.startsWith('[TrashCompact recovery context]') || Buffer.byteLength(note) > MAX_NOTE_BYTES) return;
    await atomicState(path, { boundary, epoch, bytes: transcriptBytes.length, markers, identity, configuration, created: Date.now(), note: note.trim() });
  } catch { /* Hooks always fail open without exposing transcript or credential errors. */ }
  finally { if (lock) await rm(lock, { recursive: true, force: true }).catch(() => {}); }
}
