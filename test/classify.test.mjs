import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATEGORY, POLICY, classify, applyPolicies, liveWindowStart, pathsInCommand, redact } from '../src/classify.mjs';
const message = (type, content, extra = {}) => ({ type, message: { content }, ...extra });
const result = (id, content, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });

test('role controls both string and block text classification; brief consent and refusals survive', () => {
  for (const text of ['no', 'yes', 'wait', 'please continue', 'I refuse', '<system-reminder>quoted example</system-reminder>', 'This session is being continued from a previous conversation']) {
    for (const content of [text, [{ type: 'text', text }]]) {
      const human = classify(message('user', content));
      assert.equal(human.category, CATEGORY.HUMAN_INSTRUCTION);
      assert.equal(human.text, text);
      assert.equal(classify(message('assistant', content)).category, CATEGORY.PROSE);
      assert.equal(applyPolicies([human], { totalTurns: 100 }).size, 0);
    }
  }
});
test('newer client metadata keeps assistant prose judgeable, and content-bearing envelopes stay protected', () => {
  // Claude Code 2.1.270 adds these to every assistant turn; none of them carry content.
  const entry = {
    type: 'assistant', uuid: 'u', parentUuid: 'p', timestamp: 't', sessionId: 's', version: '2.1.270',
    cwd: '/tmp', userType: 'external', isSidechain: false, isMeta: false, requestId: 'r', gitBranch: 'main',
    apiBlockIndex: 1, entrypoint: 'claude-desktop', effort: 'xhigh', perTurnEffort: 'xhigh',
    slug: 'delegated-honking-hare', quotaLimits: { status: 'rejected' },
    attributionMcpServer: null, attributionMcpTool: null, attributionSkill: null,
    message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn',
      stop_sequence: null, usage: {}, container: null, stop_details: null, diagnostics: null, context_management: null,
      content: [{ type: 'text', text: 'the epoch-0 case must stay anchored to the UTC horizon' }] },
  };
  const prose = classify(entry);
  assert.equal(prose.category, CATEGORY.PROSE);
  assert.equal(POLICY[prose.category].judge, true);
  // An unknown key is still unknown: it may carry context, so the record stays out of judging.
  assert.notEqual(classify({ ...entry, somethingNew: 'unrecognised' }).category, CATEGORY.PROSE);
  // Error envelopes are content, not bookkeeping.
  assert.notEqual(classify({ ...entry, isApiErrorMessage: true, apiErrorStatus: 429 }).category, CATEGORY.PROSE);
});

test('local session state is removable; rendered and hook-bearing records are not', () => {
  for (const type of ['last-prompt', 'atis-latch', 'mode', 'custom-title', 'file-history-delta', 'file-history-snapshot', 'queue-operation']) {
    const record = classify({ type, sessionId: 's' });
    assert.equal(record.category, CATEGORY.LOCAL_ONLY, type);
    assert.equal(applyPolicies([record]).size, 1, type);
  }
  for (const entry of [{ type: 'attachment', rendered: 'file contents the model saw' }, { type: 'system', hookAdditionalContext: 'recovery note' }]) {
    const record = classify(entry);
    assert.equal(record.category, CATEGORY.TOOL_OUTPUT, entry.type);
    assert.equal(record.pinned, true, entry.type);
    assert.ok(record.text.includes(entry.rendered ?? entry.hookAdditionalContext));
    assert.equal(applyPolicies([record]).size, 0, entry.type);
  }
});

test('redaction cannot corrupt code, literals, whitespace or intent', () => {
  const text = '  const ass = "shit"; // NOT fucking working\n\tassert(ass);\n';
  assert.equal(redact(text), text);
  assert.equal(classify(message('user', text)).text, text);
});
test('all tool results, mixed prose, image evidence and calls remain represented and protected', () => {
  const image = { type: 'image', source: { type: 'base64', data: 'YWJj' } };
  const blocks = [result('a', [{ type: 'text', text: 'first failure' }, image], { is_error: true }), result('b', 'second finding'), { type: 'text', text: 'stop now' }];
  const record = classify(message('user', blocks));
  for (const text of ['first failure', 'second finding', 'stop now', '[image]', 'error']) assert.ok(record.text.includes(text));
  assert.equal(record.imageBytes, 4);
  assert.equal(record.category, CATEGORY.HUMAN_INSTRUCTION);
  assert.equal(record.pinned, true);
  const calls = classify(message('assistant', [{ type: 'text', text: 'unresolved diagnosis' }, { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/one/two/three/four.js' } }, { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'echo fail' } }]));
  for (const text of ['unresolved diagnosis', 'four.js', 'echo fail']) assert.ok(calls.text.includes(text));
  assert.equal(calls.pinned, true);
});
test('unknown blocks, missing content, image-only and signed thinking are not empty', () => {
  for (const content of [undefined, [{ type: 'future', payload: 'important' }], [{ type: 'image', source: { data: 'abcd' } }], [{ type: 'thinking', thinking: '', signature: 'signed' }], [{ type: 'redacted_thinking', data: 'signed' }]]) {
    const record = classify(message('assistant', content));
    assert.notEqual(record.category, CATEGORY.EMPTY);
    assert.equal(applyPolicies([record], { totalTurns: 1000 }).size, 0);
    assert.equal(record.pinned, true);
  }
});
test('summary protection works for every content representation without inventing a live boundary', () => {
  for (const content of ['summary', [{ type: 'text', text: 'summary' }], undefined]) {
    const record = classify(message('user', content, { isCompactSummary: true }));
    assert.equal(record.category, CATEGORY.COMPACT_SUMMARY);
    assert.equal(record.pinned, true);
  }
  assert.equal(liveWindowStart([{ isCompactSummary: true }, message('user', 'retained earlier turn'), { type: 'system', subtype: 'compact_boundary', compactMetadata: { preservedSegment: { headUuid: 'earlier' } } }, { isCompactSummary: true }]), 0);
});
test('full paths, partial reads, unknown tools and old failures never supersede by age or target', () => {
  const tools = new Map([
    ['a', { name: 'Bash', input: { command: 'cat /root1/a/b/file.js' } }],
    ['b', { name: 'Bash', input: { command: "sed -n '1,2p' /root1/a/b/file.js" } }],
    ['c', { name: 'Read', input: { file_path: '/root2/a/b/file.js', offset: 4 } }],
    ['d', { name: 'Bash', input: { command: 'npm test' } }],
  ]);
  const records = ['a', 'b', 'c', 'd', 'unknown1', 'unknown2'].map(id => classify(message('user', [result(id, 'FAIL unresolved')]), tools));
  assert.deepEqual(records[0].paths, ['/root1/a/b/file.js']);
  assert.deepEqual(records[2].paths, ['/root2/a/b/file.js']);
  assert.notEqual(records[0].supersedeKey, records[1].supersedeKey);
  assert.notEqual(records[4].supersedeKey, records[5].supersedeKey);
  assert.equal(applyPolicies(records, { turnOf: () => 0, totalTurns: 1000 }).size, 0);
  assert.ok(records.every(record => POLICY[record.category].eligible));
  assert.deepEqual(pathsInCommand('cat "/a path/file.js" /tmp/important.txt'), ['/a path/file.js', '/tmp/important.txt']);
});
test('proven local and empty records drop inside the tail; unknown metadata survives', () => {
  const records = [classify({ type: 'file-history-snapshot' }), classify(message('assistant', [])), classify({ type: 'future-record', value: 'context' }), classify(message('assistant', ''))];
  assert.deepEqual([...applyPolicies(records, { keepTail: 1 }).keys()], [0, 1, 3]);
});
test('empty user messages and assistant text with unknown fields stay protected', () => {
  for (const entry of [message('user',''), message('user',[]),
    {...message('assistant',''), extra:'Keep this context'},
    {type:'assistant',message:{content:[{type:'text',text:'',extra:'Keep this context'}]}},
    {type:'assistant',message:{content:'',extra:'Keep this context'}},
  ]) {
    const record=classify(entry);
    assert.notEqual(record.category,CATEGORY.EMPTY);
    assert.equal(applyPolicies([record],{keepTail:5}).size,0);
  }
  for (const protection of [{protected:true},{pinned:true},{hardProtected:true,tailProtected:true}]) {
    assert.equal(applyPolicies([{category:CATEGORY.EMPTY,...protection}],{keepTail:5}).size,0);
  }
});

test('malformed text blocks preserve complete data and never enter prose judging', () => {
  for (const text of [undefined, null, 0, false, { evidence: 'unresolved' }, ['evidence']]) {
    const block = { type: 'text', text };
    for (const role of ['assistant', 'user']) {
      const record = classify(message(role, [block]));
      assert.notEqual(record.category, CATEGORY.PROSE);
      assert.notEqual(record.category, CATEGORY.EMPTY);
      assert.equal(record.pinned, true);
      assert.equal(record.text, JSON.stringify(block));
      assert.equal(applyPolicies([record]).size, 0);
    }
  }
});
test('classifier self-test runs only as a directly invoked script', () => {
  const moduleUrl = new URL('../src/classify.mjs', import.meta.url);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `process.argv.push('--self-test'); await import(${JSON.stringify(moduleUrl.href)});`], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  const direct = spawnSync(process.execPath, [fileURLToPath(moduleUrl), '--self-test'], { encoding: 'utf8' });
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, /classify self-test: all checks passed/);
});
