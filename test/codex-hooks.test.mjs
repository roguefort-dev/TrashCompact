import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli } from '../hooks/common.mjs';
const root = resolve(import.meta.dirname, '..');
const note = '[TrashCompact recovery context]\nEarlier task evidence, subordinate to newer instructions.\nPreserve the cache contract.';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trashcompact-codex-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(root, 'hooks'), join(dir, 'hooks'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  const transcript = join(dir, 'rollout.jsonl');
  writeFileSync(transcript, '{"type":"session_meta"}\n');
  const launcher = join(dir, 'bin/launch.mjs');
  const log = join(dir, 'args.json');
  const stub = (output = note, code = 0) => writeFileSync(launcher,
    `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exit(${code});\n`, { mode: 0o700 });
  stub();
  const input = { session_id: 'session-a', transcript_path: transcript };
  const run = (mode, changes = {}, flags = '') => {
    const result = spawnSync(process.execPath, [join(dir, `hooks/on-${mode}.mjs`)], {
      input: JSON.stringify({ ...input, ...(mode === 'sessionstart' ? { source: 'compact' } : {}), ...changes }), encoding: 'utf8',
      env: { ...process.env, HOME: dir, CODEX_HOME: join(dir, 'custom-codex'), TRASHCOMPACT_FLAGS: flags, TYPESAFE_API_KEY: '', TRASHCOMPACT_ENV: join(dir,'missing-env') },
    });
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    return result.stdout;
  };
  const snapshot = () => {
    const cache = join(dir, 'custom-codex/trashcompact/recovery');
    const name = readdirSync(cache).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    return join(cache, name);
  };
  return { dir, transcript, log, stub, run, snapshot };
}
test('manual legacy Stop and compaction-only recovery deliver exactly one bounded JSON context', t => {
  const f = fixture(t);
  assert.equal(f.run('stop'), '');
  assert.deepEqual(JSON.parse(readFileSync(f.log)), [f.transcript, '--format', 'codex', '--update']);
  assert.equal(f.run('precompact'), '');
  assert.deepEqual(JSON.parse(readFileSync(f.log)), [f.transcript, '--format', 'codex', '--recovery', '--recovery-rank', '--offline']);
  assert.equal(statSync(f.snapshot()).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.dir, 'custom-codex/trashcompact/recovery')).mode & 0o777, 0o700);
  assert.equal(f.run('sessionstart', { source: 'startup' }), '');
  // Codex appends its compaction record before SessionStart.
  appendFileSync(f.transcript, '{"type":"compacted"}\n');
  const output = JSON.parse(f.run('sessionstart'));
  assert.deepEqual(output, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } });
  assert.ok(Buffer.byteLength(output.hookSpecificOutput.additionalContext) <= 6000);
  assert.equal(f.run('sessionstart'), '');
});
test('session identity, null transcript, subagents and duplicate boundaries fail open', t => {
  const f = fixture(t);
  f.run('precompact');
  assert.equal(f.run('sessionstart', { session_id: 'session-b' }), '');
  assert.equal(f.run('sessionstart', { agent_id: 'child' }), '');
  assert.ok(f.run('sessionstart'));
  assert.equal(f.run('precompact'), '');
  assert.equal(f.run('sessionstart'), '');
  appendFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: { text: 'new boundary' } }) + '\n'); f.run('precompact');
  assert.equal(f.run('sessionstart', { transcript_path: null }), '');
  assert.equal(f.run('sessionstart'), '');
  appendFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: { text: 'next boundary' } }) + '\n'); f.run('precompact');
  const other = join(f.dir, 'other.jsonl'); writeFileSync(other, 'other');
  assert.equal(f.run('sessionstart', { transcript_path: other }), '');
  assert.equal(f.run('sessionstart'), '');
});
test('failed or invalid refresh never reinjects an old snapshot', t => {
  const f = fixture(t);
  for (const [output, exitCode, flags, path] of [[note, 1, '', f.transcript], ['garbage', 0, '', f.transcript], [note + 'é'.repeat(4000), 0, '', f.transcript], [note, 0, '--format claude', f.transcript], [note, 0, '', null]]) {
    appendFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: { text: 'first boundary' } }) + '\n'); f.stub(); f.run('precompact');
    appendFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: { text: 'second boundary' } }) + '\n'); f.stub(output, exitCode);
    assert.equal(f.run('precompact', { transcript_path: path }, flags), '');
    assert.equal(f.run('sessionstart'), '');
  }
});
test('delayed notes survive until the matching completed compaction', t => {
  const f = fixture(t); f.run('precompact');
  const path = f.snapshot(), state = JSON.parse(readFileSync(path));
  state.created = Date.now() - 11 * 60 * 1000; writeFileSync(path, JSON.stringify(state));
  assert.equal(JSON.parse(f.run('sessionstart')).hookSpecificOutput.additionalContext, note);
  assert.equal(JSON.parse(readFileSync(path)).note, undefined);
});
test('real offline CLI lifecycle preserves latest unscored Codex evidence without credentials', t => {
  const f = fixture(t);
  cpSync(join(root, 'src'), join(f.dir, 'src'), { recursive: true });
  cpSync(join(root, 'bin'), join(f.dir, 'bin'), { recursive: true });
  writeFileSync(f.transcript, [
    { type: 'session_meta', payload: { id: 'session-a' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep the API response schema stable. Pending task: fix cache invalidation.' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Diagnosis: stale cache keys caused the mismatch; preserve canonical identities.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  assert.equal(f.run('precompact'), '');
  const output = JSON.parse(f.run('sessionstart'));
  assert.match(output.hookSpecificOutput.additionalContext, /Pending task: fix cache invalidation/);
  assert.match(output.hookSpecificOutput.additionalContext, /stale cache keys/);
  assert.equal(f.run('sessionstart'), '');
});
test('duplicate PreCompact preserves a valid pending note and consumed boundaries never replay', t => {
  const f = fixture(t);
  f.run('precompact');
  const staged = readFileSync(f.snapshot(), 'utf8');
  // A duplicate must preserve the existing note without calling the CLI again.
  f.stub('unexpected child invocation', 1);
  assert.equal(f.run('precompact'), '');
  assert.equal(readFileSync(f.snapshot(), 'utf8'), staged);
  assert.equal(JSON.parse(f.run('sessionstart')).hookSpecificOutput.additionalContext, note);
  f.stub();
  assert.equal(f.run('precompact', {}, '--threshold 0.7'), '');
  assert.equal(f.run('sessionstart'), '');
});
test('duplicate boundary with invalid or failing changed flags invalidates the pending note', t => {
  for (const flags of ['--format claude', '--threshold invalid']) {
    const f = fixture(t);
    f.run('precompact'); f.stub('failed refresh', 1);
    assert.equal(f.run('precompact', {}, flags), '');
    assert.equal(f.run('sessionstart'), '');
  }
});
test('PreCompact runs one synchronous online pre-pass then offline ranked recovery, including online failure fallback', t => {
  for (const failOnline of [false,true]) {
    const f=fixture(t), audit=join(f.dir,'ordered.jsonl');
    writeFileSync(join(f.dir,'bin/launch.mjs'),`#!${process.execPath}\nimport {appendFileSync} from 'node:fs';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(audit)},JSON.stringify(args)+'\\n');if(args.includes('--update')){process.exit(${failOnline?1:0});}process.stdout.write(${JSON.stringify(note)});`,{mode:0o700});
    assert.equal(f.run('precompact'), '');
    const calls=readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls,[
      [f.transcript,'--format','codex','--update','--recovery-rank'],
      [f.transcript,'--format','codex','--recovery','--recovery-rank','--offline'],
    ]);
    assert.equal(f.run('precompact'), '');
    assert.equal(readFileSync(audit,'utf8').trim().split('\n').length,2);
    assert.equal(JSON.parse(f.run('sessionstart')).hookSpecificOutput.additionalContext,note);
    assert.equal(f.run('sessionstart'),'');
  }
});
test('bounded CLI timeout terminates a child that ignores SIGTERM and returns failure for offline fallback', async t => {
  const f=fixture(t), launcher=join(f.dir,'bin/stubborn');
  writeFileSync(launcher,`#!${process.execPath}\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},100);`,{mode:0o700});
  const start=Date.now();
  assert.equal(await runCli([],150,launcher),null);
  assert.ok(Date.now()-start<5000);
});

test('confirmed native completion clears the selected cache and keeps the prepared note; duplicate preserves rebuilt scores', async t => {
  const { openState, saveState, loadState } = await import('../src/scoring-state.mjs');
  const { loadRecords } = await import('../src/filter-transcript.mjs');
  const f = fixture(t), path = join(f.dir, 'chosen-scores.json'), flags = `--state "${path}"`;
  const old = openState(path, loadRecords(f.transcript, { format: 'codex' }).epoch);
  old.verdicts.old = {}; old.recoveryRank = { passages: { old: {} }, relations: {} }; saveState(path, old);
  f.run('precompact', {}, flags);
  assert.ok(loadState(path).verdicts.old);
  appendFileSync(f.transcript, '{"type":"compacted","payload":{"message":"native rewrite"}}\n');
  assert.equal(JSON.parse(f.run('sessionstart', {}, flags)).hookSpecificOutput.additionalContext, note);
  assert.deepEqual(loadState(path).verdicts, {}); assert.equal(loadState(path).recoveryRank, undefined);
  const rebuilt = openState(path, loadRecords(f.transcript, { format: 'codex' }).epoch);
  rebuilt.verdicts.fresh = {}; saveState(path, rebuilt);
  assert.equal(f.run('sessionstart', {}, flags), '');
  assert.ok(loadState(path).verdicts.fresh);
  assert.throws(() => saveState(path, old), /changed after native compaction/);
  // A second confirmed compaction can keep the same visible marker.
  appendFileSync(f.transcript, '{"type":"event_msg","payload":{"text":"next turn"}}\n');
  f.run('precompact', {}, flags); f.run('sessionstart', {}, flags);
  assert.deepEqual(loadState(path).verdicts, {});
});
test('SessionStart clears scores even when recovery note preparation failed', async t => {
  const { openState, saveState, loadState } = await import('../src/scoring-state.mjs');
  const { loadRecords } = await import('../src/filter-transcript.mjs');
  const f = fixture(t), path = join(f.dir, 'scores.json'), flags = `--state "${path}"`;
  const old = openState(path, loadRecords(f.transcript, { format: 'codex' }).epoch);
  old.verdicts.old = {}; saveState(path, old);
  f.stub('', 1); f.run('precompact', {}, flags);
  assert.ok(loadState(path).verdicts.old);
  assert.equal(f.run('sessionstart', {}, flags), '');
  assert.deepEqual(loadState(path).verdicts, {});
});

test('a held scoring lock cannot lose a recovery note; pending markerless reset blocks Stop until it succeeds', async t => {
  const { openState, saveState, loadState } = await import('../src/scoring-state.mjs');
  const { loadRecords } = await import('../src/filter-transcript.mjs');
  const f = fixture(t), path = join(f.dir, 'scores.json'), flags = `--state "${path}"`;
  const old = openState(path, loadRecords(f.transcript, { format: 'codex' }).epoch);
  old.verdicts.old = {}; saveState(path, old);
  f.run('precompact', {}, flags);
  mkdirSync(`${path}.lock`);
  assert.equal(JSON.parse(f.run('sessionstart', {}, flags)).hookSpecificOutput.additionalContext, note);
  assert.ok(loadState(path).verdicts.old);
  assert.ok(JSON.parse(readFileSync(f.snapshot())).pending);
  writeFileSync(f.log, 'not launched');
  f.run('stop', {}, flags);
  assert.equal(readFileSync(f.log, 'utf8'), 'not launched');
  assert.equal(f.run('sessionstart', {}, flags), '');
  rmSync(`${path}.lock`, { recursive: true });
  f.run('stop', {}, flags);
  assert.deepEqual(loadState(path).verdicts, {});
  assert.ok(JSON.parse(readFileSync(f.log)).includes('--update'));
  const rebuilt = openState(path, loadRecords(f.transcript, { format: 'codex' }).epoch);
  rebuilt.verdicts.new = {}; saveState(path, rebuilt);
  f.run('stop', {}, flags);
  assert.ok(loadState(path).verdicts.new);
});

test('generation changes during completion preserve delivery and reconcile before the next Stop', async t => {
  const { openState, saveState, loadState } = await import('../src/scoring-state.mjs');
  const { loadRecords } = await import('../src/filter-transcript.mjs');
  const f = fixture(t), path = join(f.dir, 'scores.json'), flags = `--state "${path}"`;
  const old = openState(path, loadRecords(f.transcript, { format: 'codex' }).epoch);
  old.verdicts.old = {}; saveState(path, old);
  f.run('precompact', {}, flags);
  // Deterministically insert another generation between the hook's source read
  // and its compare-and-swap, using only this fixture's copied cache module.
  const modulePath = join(f.dir, 'src/scoring-state.mjs'), once = join(f.dir, 'race-once');
  const source = readFileSync(modulePath, 'utf8');
  writeFileSync(modulePath, source.replace('export function completeCompaction(path, epoch, completion, hasMarker = true, expected) {',
    `export function completeCompaction(path, epoch, completion, hasMarker = true, expected) {
      if (!existsSync(${JSON.stringify(once)})) {
        writeFileSync(${JSON.stringify(once)}, 'done');
        openState(path, 'concurrent-generation');
      }`));
  assert.equal(JSON.parse(f.run('sessionstart', {}, flags)).hookSpecificOutput.additionalContext, note);
  assert.ok(JSON.parse(readFileSync(f.snapshot())).pending);
  f.run('stop', {}, flags);
  assert.equal(loadState(path).epoch, loadRecords(f.transcript, { format: 'codex' }).epoch);
  assert.equal(f.run('sessionstart', {}, flags), '');
});

test('retrying an older pending completion preserves judgments already bound to a later native marker', async t => {
  const { openState, saveState, loadState } = await import('../src/scoring-state.mjs');
  const { loadRecords } = await import('../src/filter-transcript.mjs');
  const f = fixture(t), path = join(f.dir, 'scores.json'), flags = `--state "${path}"`;
  openState(path, loadRecords(f.transcript, { format: 'codex' }).epoch);
  f.run('precompact', {}, flags);
  mkdirSync(`${path}.lock`); f.run('sessionstart', {}, flags); rmSync(`${path}.lock`, { recursive: true });
  appendFileSync(f.transcript, '{"type":"compacted","payload":{"message":"later native state"}}\n');
  const later = openState(path, loadRecords(f.transcript, { format: 'codex' }).epoch);
  later.verdicts.fresh = {}; saveState(path, later);
  f.run('stop', {}, flags);
  assert.equal(loadState(path).generation, later.generation);
  assert.deepEqual(loadState(path).verdicts, later.verdicts);
});

test('PostCompact resets immediately, retains delayed recovery, and never resets rebuilt scores on delivery', async t => {
  const { openState, saveState, loadState } = await import('../src/scoring-state.mjs');
  const { loadRecords } = await import('../src/filter-transcript.mjs');
  const f = fixture(t), path = join(f.dir, 'post-scores.json'), flags = `--state "${path}"`;
  const old = openState(path, loadRecords(f.transcript, { format: 'codex' }).epoch);
  old.verdicts.old = {}; saveState(path, old);
  f.run('precompact', {}, flags);
  appendFileSync(f.transcript, '{"type":"compacted","payload":{"message":"native completion"}}\n');
  assert.equal(f.run('postcompact', {}, flags), '');
  assert.deepEqual(loadState(path).verdicts, {});
  const snapshot = JSON.parse(readFileSync(f.snapshot()));
  snapshot.created = Date.now() - 24 * 60 * 60 * 1000;
  writeFileSync(f.snapshot(), JSON.stringify(snapshot));
  const rebuilt = openState(path, loadRecords(f.transcript, { format: 'codex' }).epoch);
  rebuilt.verdicts.fresh = {}; saveState(path, rebuilt);
  assert.equal(f.run('postcompact', {}, flags), '');
  assert.equal(JSON.parse(f.run('sessionstart', {}, flags)).hookSpecificOutput.additionalContext, note);
  assert.ok(loadState(path).verdicts.fresh);
  assert.equal(f.run('postcompact', {}, flags), '');
  assert.equal(f.run('sessionstart', {}, flags), '');
  assert.ok(loadState(path).verdicts.fresh);
});

test('durable recovery rejects changed configuration, rewritten prefixes, and later completed compactions', t => {
  for (const change of ['configuration', 'rewrite', 'two-markers', 'completed-epoch']) {
    const f = fixture(t);
    f.run('precompact');
    if (change === 'rewrite') writeFileSync(f.transcript, '{"type":"session_meta","payload":{"changed":true}}\n');
    if (change === 'two-markers' || change === 'completed-epoch') {
      appendFileSync(f.transcript, '{"type":"compacted","payload":{"message":"first"}}\n');
      if (change === 'completed-epoch') f.run('postcompact');
      appendFileSync(f.transcript, '{"type":"compacted","payload":{"message":"second"}}\n');
    }
    assert.equal(f.run('sessionstart', {}, change === 'configuration' ? '--threshold 0.8' : ''), '');
    assert.equal(f.run('sessionstart'), '');
  }
});

test('PostCompact resets even without a recovery note and retries a contended reset through Stop', async t => {
  const { openState, saveState, loadState } = await import('../src/scoring-state.mjs');
  const { loadRecords } = await import('../src/filter-transcript.mjs');
  const f = fixture(t), path = join(f.dir, 'contended-post.json'), flags = `--state "${path}"`;
  const old = openState(path, loadRecords(f.transcript, { format: 'codex' }).epoch);
  old.verdicts.old = {}; saveState(path, old);
  f.stub('', 1); f.run('precompact', {}, flags);
  mkdirSync(`${path}.lock`);
  assert.equal(f.run('postcompact', {}, flags), '');
  assert.ok(loadState(path).verdicts.old);
  assert.ok(JSON.parse(readFileSync(f.snapshot())).pending);
  rmSync(`${path}.lock`, { recursive: true });
  f.run('stop', {}, flags);
  assert.deepEqual(loadState(path).verdicts, {});
  assert.equal(f.run('sessionstart', {}, flags), '');
});

test('malformed durable boundary metadata cannot deliver recovery', t => {
  for (const invalid of [{ bytes: -1 }, { markers: -1 }, { markers: 100 }, { markers: null }]) {
    const f = fixture(t); f.run('precompact');
    writeFileSync(f.snapshot(), JSON.stringify({ ...JSON.parse(readFileSync(f.snapshot())), ...invalid }));
    assert.equal(f.run('sessionstart'), '');
  }
});
