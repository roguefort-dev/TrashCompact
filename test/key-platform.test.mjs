import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPrivateKey } from '../install/key.mjs';
import { credentialPath, savePrivateKey, restrictWindowsAccess } from '../install/write-key.mjs';

const root = resolve(import.meta.dirname, '..');
const synthetic = 'synthetic-private-key_123';
function temporaryHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'trashcompact-key-platform-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
function terminal(wasRaw = false) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = wasRaw;
  input.rawChanges = [];
  input.setRawMode = value => { input.isRaw = value; input.rawChanges.push(value); };
  input.pause = () => { input.paused = true; };
  input.resume = () => { input.paused = false; };
  const output = { isTTY: true, text: '', write(text) { this.text += text; } };
  return { input, output, signals: new EventEmitter() };
}
function assertTerminalRestored(io, wasRaw = false) {
  assert.equal(io.input.isRaw, wasRaw);
  assert.equal(io.input.paused, true);
  assert.equal(io.input.listenerCount('data'), 0);
  for (const event of ['end', 'close', 'error']) assert.equal(io.input.listenerCount(event), 0);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(io.signals.listenerCount(signal), 0);
  assert.ok(!io.output.text.includes(synthetic));
}

test('portable key command rejects arguments and piped input without displaying them', t => {
  const home = temporaryHome(t);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TRASHCOMPACT_ENV: join(home, 'env') };
  for (const args of [[synthetic], []]) {
    const result = spawnSync(process.execPath, [join(root, 'install/key.mjs'), ...args], { input: synthetic, encoding: 'utf8', env });
    assert.equal(result.status, args.length ? 2 : 1);
    assert.ok(!result.stdout.includes(synthetic));
    assert.ok(!result.stderr.includes(synthetic));
    assert.match(result.stderr, args.length ? /Usage:/ : /interactive terminal/);
  }
  assert.deepEqual(readdirSync(home), []);
});

test('hidden reader handles editing and restores the original terminal raw mode', async () => {
  for (const wasRaw of [false, true]) {
    const io = terminal(wasRaw);
    const result = readPrivateKey(io);
    assert.equal(io.input.isRaw, true);
    io.input.emit('data', Buffer.from('discard\x15'));
    io.input.emit('data', Buffer.from(`${synthetic}xy\b\x7f\r`));
    assert.equal(await result, synthetic);
    assert.deepEqual(io.input.rawChanges, [true, wasRaw]);
    assertTerminalRestored(io, wasRaw);
    assert.ok(!io.output.text.includes('discard'));
  }
});

test('hidden reader skips on empty Enter and cancels on escape, EOF, signals, or terminal failure', async () => {
  const blank = terminal();
  const skipped = readPrivateKey(blank);
  blank.input.emit('data', Buffer.from('\r'));
  assert.equal(await skipped, '');
  assertTerminalRestored(blank);
  const actions = [
    io => io.input.emit('data', Buffer.from('\x03')),
    io => io.input.emit('data', Buffer.from('\x04')),
    io => io.input.emit('data', Buffer.from('\x1b[A')),
    io => io.input.emit('end'),
    io => io.input.emit('close'),
    io => io.input.emit('error', new Error(synthetic)),
    ...['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => io => io.signals.emit(signal)),
  ];
  for (const action of actions) {
    const io = terminal();
    const result = readPrivateKey(io);
    io.input.emit('data', Buffer.from(synthetic));
    action(io);
    await assert.rejects(result, error => !error.message.includes(synthetic) && /unchanged/i.test(error.message));
    assertTerminalRestored(io);
  }
});

test('credential path falls back to the OS home without reading credentials', () => {
  assert.equal(credentialPath({}), join(homedir(), '.config', 'typesafe', 'env'));
  assert.equal(credentialPath({ HOME: '/synthetic-home' }), join('/synthetic-home', '.config', 'typesafe', 'env'));
});

test('Windows ACL failure preserves the existing file and writes no secret to staging', t => {
  const home = temporaryHome(t);
  const path = join(home, 'env');
  const existing = 'OTHER=keep\nTYPESAFE_API_KEY=synthetic-old\n';
  writeFileSync(path, existing);
  for (const failKind of ['directory', 'file']) {
    const seen = [];
    assert.throws(() => savePrivateKey(synthetic, {
      env: { HOME: home, TRASHCOMPACT_ENV: path },
      platform: 'win32',
      restrictAccess(staged, kind) {
        seen.push(kind);
        if (kind === 'directory') assert.deepEqual(readdirSync(staged), []);
        else assert.equal(readFileSync(staged, 'utf8'), '');
        if (kind === failKind) throw new Error('Synthetic ACL failure');
      },
    }), /Synthetic ACL failure/);
    assert.deepEqual(seen, failKind === 'directory' ? ['directory'] : ['directory', 'file']);
    assert.equal(readFileSync(path, 'utf8'), existing);
    assert.deepEqual(readdirSync(home), ['env']);
  }
});

test('Windows ACL command restricts and verifies access without putting paths or secrets in arguments', () => {
  const path = resolve('synthetic path with spaces', 'env');
  restrictWindowsAccess(path, 'file', {
    env: { SystemRoot: 'C:\\Windows' },
    run(command, args, options) {
      assert.ok(command.endsWith('powershell.exe'));
      assert.ok(!args.join(' ').includes(path));
      assert.ok(!args.join(' ').includes(synthetic));
      assert.equal(options.env.TRASHCOMPACT_PRIVATE_PATH, path);
      assert.equal(options.env.TRASHCOMPACT_PRIVATE_KIND, 'file');
      assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore']);
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
      assert.match(script, /WindowsIdentity\]::GetCurrent\(\)\.User/);
      assert.match(script, /AreAccessRulesProtected/);
      assert.match(script, /GetAccessRules/);
      return { status: 0 };
    },
  });
  for (const failure of [{ status: 1 }, { status: null, error: new Error('not found') }]) {
    assert.throws(() => restrictWindowsAccess(path, 'file', { run: () => failure }), /restrict credential access/);
  }
});

test('POSIX replacement is private and preserves unrelated credential settings', { skip: process.platform === 'win32' }, t => {
  const home = temporaryHome(t);
  const path = join(home, 'nested', 'env');
  mkdirSync(join(home, 'nested'));
  writeFileSync(path, 'OTHER=keep\nexport TYPESAFE_API_KEY=synthetic-old\nTYPESAFE_API_KEY=duplicate\n', { mode: 0o644 });
  savePrivateKey(synthetic, { env: { HOME: home, TRASHCOMPACT_ENV: path } });
  assert.equal(readFileSync(path, 'utf8'), `OTHER=keep\nTYPESAFE_API_KEY=${synthetic}\n`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(home, 'nested')), ['env']);
});

test('native Windows replacement keeps only the current user in a protected credential ACL', { skip: process.platform !== 'win32' }, t => {
  const home = temporaryHome(t);
  const path = join(home, 'credentials with spaces', 'env');
  mkdirSync(join(home, 'credentials with spaces'));
  writeFileSync(path, 'OTHER=keep\nTYPESAFE_API_KEY=synthetic-old\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TRASHCOMPACT_ENV: path };
  savePrivateKey(synthetic, { env });
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $env:TRASHCOMPACT_ENV
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (!$acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].IsInherited) { exit 1 }
`;
  const result = spawnSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, 'The saved file must retain its private ACL after the atomic replacement.');
  assert.equal(readFileSync(path, 'utf8'), `OTHER=keep\nTYPESAFE_API_KEY=${synthetic}\n`);
  assert.deepEqual(readdirSync(join(home, 'credentials with spaces')), ['env']);
});
