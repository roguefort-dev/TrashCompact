import { createHash } from 'node:crypto';
import { hostname, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hookFlags, runCli } from '../hooks/common.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const textParts = parts => Array.isArray(parts) ? parts.filter(p => p?.type === 'text' && !p.ignored && typeof p.text === 'string').map(p => p.text).join('\n') : '';
const item = payload => ({ type: 'response_item', payload });
const message = (role, text) => item({ type: 'message', role, content: [{ type: 'text', text }] });
const call = (id, name, input) => item({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(input ?? {}) });
const result = (id, text) => item({ type: 'function_call_output', call_id: id, output: text });

// Whitelist visible text and documented tool fields. Never serialize an entire
// API message: reasoning, provider metadata, images and unknown parts stay out.
export function convertMessages(messages, version) {
  const records = [];
  for (const entry of messages ?? []) {
    const role = version === 1 ? entry?.info?.role : entry?.role;
    if (!['user', 'assistant', 'tool'].includes(role)) continue;
    const parts = version === 1 ? entry.parts : entry.content;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part?.type === 'text' && !part.ignored && typeof part.text === 'string' && role !== 'tool') records.push(message(role, part.text));
      if (version === 1 && role === 'assistant' && part?.type === 'tool' && typeof part.callID === 'string' && typeof part.tool === 'string') {
        records.push(call(part.callID, part.tool, part.state?.input));
        if (part.state?.status === 'completed' && typeof part.state.output === 'string') records.push(result(part.callID, part.state.output));
        if (part.state?.status === 'error' && typeof part.state.error === 'string') records.push(result(part.callID, part.state.error));
      }
      if (version === 2 && role === 'assistant' && part?.type === 'tool-call' && typeof part.id === 'string' && typeof part.name === 'string') records.push(call(part.id, part.name, part.input));
      if (version === 2 && ['assistant', 'tool'].includes(role) && part?.type === 'tool-result' && typeof part.id === 'string') {
        const value = part.result;
        const text = ['text', 'error'].includes(value?.type) && typeof value.value === 'string' ? value.value : value?.type === 'content' ? textParts(value.value) : '';
        if (text) records.push(result(part.id, text));
      }
    }
  }
  return records;
}

export function createRecovery({ run = runCli, env = process.env, temporaryRoot = tmpdir() } = {}) {
  const active = new Set();
  return async ({ sessionID, directory, version, messages }) => {
    if (typeof sessionID !== 'string' || !sessionID || typeof directory !== 'string' || !directory) return;
    const identity = digest(JSON.stringify([hostname(), directory, version, sessionID]));
    if (active.has(identity)) return;
    active.add(identity);
    let temporary;
    try {
      const records = convertMessages(messages, version);
      if (!records.length) return;
      const flags = hookFlags(env.TRASHCOMPACT_FLAGS ?? '').filter(f => f !== '--recovery-rank');
      // A caller-supplied --state would break per-session isolation.
      if (flags.includes('--state')) return;
      const cache = join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache'), 'trashcompact', 'opencode');
      await mkdir(cache, { recursive: true, mode: 0o700 });
      await chmod(cache, 0o700);
      temporary = await mkdtemp(join(temporaryRoot, 'trashcompact-opencode-'));
      const transcript = join(temporary, 'visible.jsonl');
      await writeFile(transcript, records.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
      const args = [transcript, ...flags, '--state', join(cache, `${identity}.json`), '--format', 'codex'];
      await run([...args, '--update', '--recovery-rank'], 45000);
      const note = await run([...args, '--recovery', '--recovery-rank', '--offline'], 10000);
      if (typeof note === 'string' && note.startsWith('[TrashCompact recovery context]') && Buffer.byteLength(note) <= 6000) return note.trim();
    } catch { /* Compaction must still work when the scorer or API is unavailable. */ }
    finally {
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
      active.delete(identity);
    }
  };
}

export function createPlugin(options) {
  const recovery = createRecovery(options);
  return {
    id: 'trashcompact',
    async setup(ctx) {
      await ctx.session.hook('compaction', async event => {
        if (!Array.isArray(event.system)) return;
        const note = await recovery({ sessionID: event.sessionID, directory: ctx.location?.directory, version: 2, messages: event.messages });
        if (note) event.system.push({ type: 'text', text: note });
      });
    },
    async server({ client, directory }) {
      return {
        'experimental.session.compacting': async (input, output) => {
          try {
            if (!Array.isArray(output.context)) return;
            const response = await client.session.messages({ path: { id: input.sessionID }, signal: AbortSignal.timeout(10000) });
            const note = await recovery({ sessionID: input.sessionID, directory, version: 1, messages: response.data });
            if (note) output.context.push(note);
          } catch { /* Leave the native summary untouched on API failures. */ }
        },
      };
    },
  };
}
export default createPlugin();
