import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
test('private key writer replaces duplicate literal assignments atomically without disclosure', t => {
  const home = mkdtempSync(join(tmpdir(), 'trashcompact-key-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'custom/env'); mkdirSync(join(home, 'custom'));
  writeFileSync(path, 'OTHER=keep\nexport TYPESAFE_API_KEY=old\n TYPESAFE_API_KEY = duplicate\n');
  const run = input => spawnSync(process.execPath, [join(root, 'install/write-key.mjs')], { input, encoding: 'utf8', env: { ...process.env, HOME: home, TRASHCOMPACT_ENV: path } });
  const secret = 'synthetic-key_123'; const success = run(secret);
  assert.equal(success.status, 0); assert.ok(!success.stdout.includes(secret)); assert.ok(!success.stderr.includes(secret));
  assert.equal(readFileSync(path, 'utf8'), `OTHER=keep\nTYPESAFE_API_KEY=${secret}\n`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const bad of ['a b', 'a\nb', 'a$b', 'a;b', 'a`b', 'a"b', "a'b", 'a\\b', 'a\0b']) {
    const result = run(bad); assert.notEqual(result.status, 0); assert.ok(!result.stderr.includes(bad));
    assert.equal(readFileSync(path, 'utf8'), `OTHER=keep\nTYPESAFE_API_KEY=${secret}\n`);
  }
});
test('key command refuses argv secrets and piped stdin without a controlling terminal', () => {
  const result = spawnSync('/bin/bash', [join(root, 'install/key.sh'), 'SYNTHETIC_SECRET'], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.ok(!result.stderr.includes('SYNTHETIC_SECRET'));
  const noTTY = spawnSync('/bin/bash', [join(root, 'install/key.sh')], { input: 'SYNTHETIC_SECRET\n', detached: true, encoding: 'utf8' });
  assert.equal(noTTY.status, 1); assert.match(noTTY.stderr, /interactive terminal/);
});
test('hidden terminal key entry does not echo the key even under shell tracing', t => {
  const home = mkdtempSync(join(tmpdir(), 'trashcompact-key-tty-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'env');
  const script = `import os,pty,select,time,sys
pid,fd=pty.fork()
if pid==0:
 os.execv('/bin/bash',['bash','-x',sys.argv[1]])
output=b''
end=time.time()+10
sent=False
while time.time()<end:
 if select.select([fd],[],[],0.1)[0]:
  try: chunk=os.read(fd,4096)
  except OSError: break
  if not chunk: break
  output+=chunk
  if b'Enter skips): ' in output and not sent:
   os.write(fd,b'synthetic-hidden-key\\n');sent=True
else:
 os.kill(pid,9)
_,status=os.waitpid(pid,0)
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))`;
  const result = spawnSync('python3', ['-c', script, join(root, 'install/key.sh')], { encoding: 'utf8', env: { ...process.env, HOME: home, TRASHCOMPACT_ENV: path }, timeout: 12000 });
  if (result.error?.code === 'ENOENT') return t.skip('python3 unavailable for pseudo-terminal fixture');
  assert.equal(result.status, 0, result.stderr); assert.ok(!result.stdout.includes('synthetic-hidden-key'));
  assert.equal(readFileSync(path, 'utf8'), 'TYPESAFE_API_KEY=synthetic-hidden-key\n');
});
