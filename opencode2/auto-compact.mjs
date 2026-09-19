#!/usr/bin/env node
// OpenCode 2 beta REST adapter. Native compaction summarizes the active context.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function completedResponse(session, messages, directory) {
  if (session.parentID || session.time?.archived || (directory && session.location?.directory !== directory) || session.outcome !== 'succeeded') return null;
  const latest = messages[0]; // /message?order=desc
  if (latest?.type !== 'assistant' || latest.finish !== 'stop' || latest.error || !Number.isFinite(latest.time?.completed)) return null;
  return latest;
}
export function compactionID(sessionID, messageID) {
  return `msg_trashcompact_${createHash('sha256').update(`${sessionID}\0${messageID}`).digest('hex').slice(0, 40)}`;
}
export function apiClient(server, { password, username = 'opencode', fetchImpl = fetch, signal } = {}) {
  const url = new URL(server);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected an HTTP server URL without embedded credentials');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Remote servers require HTTPS');
  return async (path, body) => {
    const response = await fetchImpl(new URL(path, url), {
      method: body === undefined ? 'GET' : 'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(password ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) { const error = new Error(`OpenCode API HTTP ${response.status}`); error.status = response.status; throw error; }
    return response.status === 204 ? null : response.json();
  };
}

export class CompactionWatcher {
  constructor({ api, directory, state = { version: 1, sessions: {} }, save = async () => {}, log = () => {}, shouldStop = () => false }) {
    this.shouldStop = shouldStop; this.api = api; this.directory = directory ? resolve(directory) : undefined; this.state = state; this.save = save; this.log = log;
    if (state.version !== 1 || !state.sessions || typeof state.sessions !== 'object') throw new Error('Invalid watcher state');
  }
  async tick() {
    // Serialized polling also repairs missed events after service reconnection.
    let cursor;
    do {
      if (this.shouldStop()) return;
      const params = new URLSearchParams({ parentID: 'null', limit: '100' })
      if (this.directory) params.set('directory', this.directory);
      if (cursor) params.set('cursor', cursor); else params.set('order', 'desc');
      const page = await this.api(`/api/session?${params}`);
      for (const session of page.data) { if (this.shouldStop()) return; await this.inspect(session); }
      cursor = page.cursor?.next;
    } while (cursor);
  }
  async inspect(session) {
    const sid = session.id;
    const base = `/api/session/${encodeURIComponent(sid)}`;
    if (session.parentID || session.time?.archived || (this.directory && session.location?.directory !== this.directory) || session.outcome !== 'succeeded') return;
    const active = await this.api('/api/session/active');
    if (active.data[sid]) return;
    const messages = await this.api(`${base}/message?order=desc&limit=1`);
    const response = completedResponse(session, messages.data, this.directory);
    if (!response) return; // Includes compaction checkpoints: never recursively compact.
    if (response.time.completed < (this.state.startedAt ?? 0)) return; // No retroactive compaction when first enabled.
    let entry = this.state.sessions[sid];
    if (entry?.messageID !== response.id) {
      entry = { messageID: response.id, id: compactionID(sid, response.id), attempts: 0, status: 'pending' };
      this.state.sessions[sid] = entry;
    }
    if (entry.status !== 'pending' || entry.attempts >= 3) return;
    if ((await this.api(`${base}/inbox`)).data.length) return;
    // Recheck after reads; queue delivery avoids interrupting a prompt admitted in
    // the remaining race window. It may compact after that newer prompt instead.
    const current = (await this.api(`${base}`)).data;
    if (current.time?.updated !== session.time?.updated || current.outcome !== 'succeeded') return;
    if ((await this.api('/api/session/active')).data[sid]) return;
    if (this.shouldStop()) return;
    entry.attempts++;
    await this.save(this.state); // Durable request ID before the external mutation.
    try {
      const result = await this.api(`${base}/compact`, { id: entry.id, delivery: 'queue' });
      if (result?.data?.id !== entry.id || result.data.type !== 'compaction') throw new Error('Unexpected compaction admission');
      entry.status = 'admitted';
      this.log('Compaction queued after a completed response.');
    } catch (error) {
      // Reuse the same server-idempotent ID on ambiguous/network failures.
      if (error.status && error.status < 500 && ![408, 409, 429].includes(error.status)) entry.status = 'failed';
      this.log(`Compaction admission deferred (${entry.attempts}/3).`);
    }
    await this.save(this.state);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--once') options.once = true;
    else if (['--server', '--directory', '--state', '--password-file', '--interval', '--service-identity'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[key.slice(2)] = argv[++i];
    else throw new Error('Usage: auto-compact.mjs --server URL --directory PATH --state FILE [--password-file FILE] [--interval MS] [--once]');
  }
  if (!options.server || !options.state) throw new Error('--server and --state are required');
  const interval = Number(options.interval ?? 2000);
  if (!Number.isFinite(interval) || interval < 1000) throw new Error('Interval must be at least 1000 ms');
  const statePath = resolve(options.state);
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  // Advisory exclusive-process lock. Stale locks require explicit removal after
  // confirming the recorded PID is no longer running; never guess and double-run.
  const lockPath = `${statePath}.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Watcher state is locked; stop the other watcher or remove a confirmed stale .lock'); });
  await lock.writeFile(String(process.pid));
  let stopped = false;
  const controller = new AbortController();
  const stop = () => { stopped = true; controller.abort(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    let state = { version: 1, startedAt: Date.now(), sessions: {} };
    try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read watcher state'); }
    const identity = `${options['service-identity'] ?? new URL(options.server).origin}\0${options.directory ? resolve(options.directory) : '*'}`;
    if (state.identity && state.identity !== identity) throw new Error('State belongs to another server or directory');
    state.identity = identity;
    let password = process.env.OPENCODE_SERVER_PASSWORD;
    if (options['password-file']) password = JSON.parse(await readFile(options['password-file'], 'utf8')).password;
    const api = apiClient(options.server, { password, username: process.env.OPENCODE_SERVER_USERNAME, signal: controller.signal });
    const watcher = new CompactionWatcher({ api, directory: options.directory, state, shouldStop: () => stopped,
      save: async (value) => { await writeFile(`${statePath}.tmp`, JSON.stringify(value), { mode: 0o600 }); await rename(`${statePath}.tmp`, statePath); },
      log: (message) => process.stderr.write(`[trashcompact] ${message}\n`),
    });
    await watcher.save(state);
    do {
      try { await watcher.tick(); } catch { process.stderr.write('[trashcompact] OpenCode unavailable or incompatible; retrying later.\n'); if (options.once) process.exitCode = 1; }
      if (!options.once && !stopped) await new Promise((done) => {
        const finish = () => { clearTimeout(timer); process.off('SIGTERM', finish); process.off('SIGINT', finish); done(); };
        const timer = setTimeout(finish, interval);
        process.once('SIGTERM', finish); process.once('SIGINT', finish);
      });
    } while (!stopped && !options.once);
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    await lock.close(); await unlink(lockPath);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('[trashcompact] Invalid configuration or state; watcher stopped.\n'); process.exitCode = 1; });
}
