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
    if (args[i] === '--recovery-rank') { i++; continue; }
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unsupported hook flag');
    i += 2;
  }
  return args;
}

// PreCompact plain stdout is ignored by Codex. Stage a private, single-use note for
// SessionStart(compact), the lifecycle event that can add model context.
const MAX_NOTE_BYTES = 6000;
const MAX_AGE_MS = 10 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
function validSnapshot(snapshot, identity) {
  return typeof snapshot?.note === 'string' && snapshot.note.startsWith('[TrashCompact recovery context]') &&
    Number.isFinite(snapshot.created) && snapshot.created <= Date.now() && Date.now() - snapshot.created <= MAX_AGE_MS &&
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
    process.stdin.setEncoding('utf8');
    let raw = '';
    for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) return; }
    const input = JSON.parse(raw || '{}');
    if (!input || input.agent_id != null || typeof input.session_id !== 'string' || !input.session_id.trim()) return;
    if (mode === 'sessionstart' && input.source !== 'compact') return;
    if (mode === 'stop' && input.stop_hook_active) return;
    const stateHome = format === 'claude' ? join(process.env.HOME || homedir(), '.claude', 'trashcompact') : join(process.env.CODEX_HOME || join(process.env.HOME || homedir(), '.codex'), 'trashcompact');
    const stateFlags = transcript => format === 'claude' ? ['--state', join(stateHome, `${digest(transcript)}.json`)] : [];
    if (mode === 'stop') {
      if (typeof input.transcript_path !== 'string' || !input.transcript_path.trim()) return;
      const transcript = await realpath(resolve(input.transcript_path));
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
    if (mode === 'precompact' || mode === 'sessionstart') {
      // Invalidate before any operation that can fail, including path resolution,
      // flags, child execution, or checking a changed transcript identity.
      await atomicState(path, { boundary: previous?.boundary });
    }
    if (typeof input.transcript_path !== 'string' || !input.transcript_path.trim()) return;
    const transcript = await realpath(resolve(input.transcript_path));
    const info = await stat(transcript);
    const identity = { session: input.session_id, transcript, dev: info.dev, ino: info.ino };
    if (mode === 'sessionstart') {
      if (!validSnapshot(previous, identity)) return;
      await deliverContext(previous.note);
      return;
    }
    const extra = hookFlags(process.env.TRASHCOMPACT_FLAGS ?? '');
    if (mode !== 'precompact') return;
    const boundary = digest(await readFile(transcript));
    const configuration = digest(JSON.stringify({ lifecycle: 3, flags: extra }));
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
    await atomicState(path, { boundary });
    const rankingFlags = extra.filter(flag => flag !== '--recovery-rank');
    // This synchronous pre-pass runs only at a real compaction boundary. Failure
    // or timeout leaves compaction free to continue with an offline fallback.
    await runCli([transcript, ...rankingFlags, ...stateFlags(transcript), '--format', format, '--update', '--recovery-rank'],45000);
    const note = await runCli([transcript, ...rankingFlags, ...stateFlags(transcript), '--format', format, '--recovery', '--recovery-rank', '--offline'],10000);
    if (!note?.startsWith('[TrashCompact recovery context]') || Buffer.byteLength(note) > MAX_NOTE_BYTES) return;
    await atomicState(path, { boundary, identity, configuration, created: Date.now(), note: note.trim() });
  } catch { /* Hooks always fail open without exposing transcript or credential errors. */ }
  finally { if (lock) await rm(lock, { recursive: true, force: true }).catch(() => {}); }
}
