import test from 'node:test';
import assert from 'node:assert/strict';
import { CompactionWatcher, completedResponse, apiClient } from '../opencode2/auto-compact.mjs';
const session = () => ({ id: 'ses_test', location: { directory: '/project' }, outcome: 'succeeded', time: { updated: 10 } });
const message = () => ({ id: 'msg_response', type: 'assistant', finish: 'stop', time: { completed: 9 } });
function fixture({ overrides = {}, state = { version: 1, sessions: {} } } = {}) {
 const s = session(), m = message(), calls = [], saves = [];
 const api = async (path, body) => {
  calls.push({ path, body });
  if (overrides[path]) return overrides[path](body);
  if (path.startsWith('/api/session?')) return { data: [s], cursor: {} };
  if (path === '/api/session/active') return { data: {} };
  if (path.endsWith('/message?order=desc&limit=1')) return { data: [m] };
  if (path.endsWith('/inbox')) return { data: [] };
  if (path.endsWith('/compact')) return { data: { id: body.id, type: 'compaction' } };
  return { data: s };
 };
 const watcher = new CompactionWatcher({ api, directory: '/project', state, save: async v => saves.push(structuredClone(v)) });
 return { watcher, s, m, calls, saves, state };
}
test('durable admission once per response, no compaction feedback loop', async () => {
 const f = fixture(); await f.watcher.tick(); await f.watcher.tick();
 assert.equal(f.calls.filter(c => c.body).length, 1);
 assert.equal(f.calls.find(c => c.body).body.delivery, 'queue');
 assert.equal(f.saves[0].sessions.ses_test.status, 'pending');
 f.m.type = 'compaction'; await f.watcher.tick();
 assert.equal(f.calls.filter(c => c.body).length, 1);
 f.m.type = 'assistant'; f.m.id = 'msg_second'; await f.watcher.tick();
 assert.equal(f.calls.filter(c => c.body).length, 2);
});
test('initial enable does not compact old idle responses', async () => {
 const f = fixture({ state: { version: 1, startedAt: 20, sessions: {} } });
 await f.watcher.tick(); assert.equal(f.calls.filter(c => c.body).length, 0);
 f.m.time.completed = 21; await f.watcher.tick(); assert.equal(f.calls.filter(c => c.body).length, 1);
});
test('skip tool steps, error, interruption, subagents, archived, different location', () => {
 for (const change of [{ finish: 'tool-calls' }, { finish: 'error' }, { finish: 'length' }, { error: {} }, { time: {} }, { type: 'compaction' }]) assert.equal(completedResponse(session(), [Object.assign(message(), change)], '/project'), null);
 for (const change of [{ outcome: 'interrupted' }, { parentID: 'ses_parent' }, { time: { archived: 1 } }, { location: { directory: '/other' } }]) assert.equal(completedResponse(Object.assign(session(), change), [message()], '/project'), null);
});
test('active or queued newer work prevents admission', async () => {
 for (const overrides of [{ '/api/session/active': () => ({ data: { ses_test: {} } }) }, { '/api/session/ses_test/inbox': () => ({ data: [{}] }) }, { '/api/session/ses_test': () => ({ data: { ...session(), time: { updated: 11 } } }) }]) {
  const f = fixture({ overrides }); await f.watcher.tick(); assert.equal(f.calls.filter(c => c.body).length, 0);
 }
});
test('ambiguous admission failure retries same ID at most three times, including restart', async () => {
 const f = fixture({ overrides: { '/api/session/ses_test/compact': () => { throw new Error('network'); } } });
 for(let i=0;i<5;i++) await f.watcher.tick();
 const attempts = f.calls.filter(c => c.body); assert.equal(attempts.length, 3); assert.equal(new Set(attempts.map(c => c.body.id)).size, 1);
 const restart = fixture({ state: structuredClone(f.state) }); await restart.watcher.tick(); assert.equal(restart.calls.filter(c => c.body).length, 0);
});
test('terminal authorization errors are not retried', async () => {
 const f = fixture({ overrides: { '/api/session/ses_test/compact': () => { const e = new Error(); e.status = 401; throw e; } } });
 await f.watcher.tick(); await f.watcher.tick(); assert.equal(f.calls.filter(c => c.body).length, 1);
});
test('all project mode paginates session listing', async () => {
 let pages = 0; const f = fixture();
 const api = f.watcher.api;
 f.watcher.api = async (path, body) => {
  if (path.startsWith('/api/session?')) { pages++; assert.ok(!path.includes('directory=')); return { data: [f.s], cursor: pages === 1 ? { next: 'next' } : {} }; }
  return api(path, body);
 };
 f.watcher.directory = undefined; await f.watcher.tick(); assert.equal(pages, 2); assert.equal(f.calls.filter(c => c.body).length, 1);
});
test('API authentication stays in headers; errors exclude response bodies', async () => {
 const api = apiClient('http://127.0.0.1:1234', { password: 'synthetic-secret', fetchImpl: async (url, options) => {
  assert.ok(!String(url).includes('secret')); assert.ok(options.headers.Authorization.startsWith('Basic '));
  return new Response('secret error body', { status: 500 });
 } });
 await assert.rejects(api('/api/session'), { message: 'OpenCode API HTTP 500' });
 assert.throws(() => apiClient('http://remote.test'), /HTTPS/);
});
test('409 races are bounded and always reuse the durable ID', async () => {
 const f=fixture({overrides:{'/api/session/ses_test/compact':()=>{const e=new Error();e.status=409;throw e;}}});
 for(let i=0;i<4;i++) await f.watcher.tick();
 const requests=f.calls.filter(c=>c.body);assert.equal(requests.length,3);assert.equal(new Set(requests.map(c=>c.body.id)).size,1);
});
test('shutdown stops before scanning or mutating', async () => {
 const f=fixture();f.watcher.shouldStop=()=>true;await f.watcher.tick();assert.equal(f.calls.length,0);
});
