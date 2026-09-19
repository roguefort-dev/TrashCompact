// Private persistence for key.mjs. The pipe entry point is for internal callers.
import { readFileSync, mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// This script receives only a path and kind through the environment, never a key.
// Disable inherited access and verify the resulting ACL before writing secrets.
// Use Windows PowerShell 5.1's .NET APIs directly: a parent PowerShell 7 process
// can export module paths that prevent Set-Acl/Get-Acl from loading in 5.1.
const privateAclScript = `
$ErrorActionPreference = 'Stop'
$path = $env:TRASHCOMPACT_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:TRASHCOMPACT_PRIVATE_KIND -eq 'directory') {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
} else {
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
}
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($sid)
$acl.AddAccessRule($rule)
if ($env:TRASHCOMPACT_PRIVATE_KIND -eq 'directory') {
  [System.IO.Directory]::SetAccessControl($path, $acl)
  $check = [System.IO.Directory]::GetAccessControl($path)
} else {
  [System.IO.File]::SetAccessControl($path, $acl)
  $check = [System.IO.File]::GetAccessControl($path)
}
$rules = @($check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (!$check.AreAccessRulesProtected -or $rules.Count -ne 1 -or
    $rules[0].IdentityReference.Value -ne $sid.Value -or
    $rules[0].AccessControlType -ne 'Allow' -or
    $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
  throw 'Could not restrict credential access.'
}
`;

export function restrictWindowsAccess(path, kind, { env = process.env, run = spawnSync } = {}) {
  const powershell = env.SystemRoot
    ? join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const result = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(privateAclScript, 'utf16le').toString('base64')], {
    env: { ...env, TRASHCOMPACT_PRIVATE_PATH: resolve(path), TRASHCOMPACT_PRIVATE_KIND: kind },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) throw new Error('Could not restrict credential access.');
}

export function credentialPath(env = process.env) {
  return env.TRASHCOMPACT_ENV || join(env.HOME || homedir(), '.config', 'typesafe', 'env');
}

export function savePrivateKey(value, { env = process.env, platform = process.platform, restrictAccess = restrictWindowsAccess } = {}) {
  if (typeof value !== 'string' || !value || /[\s'"`$;\\]/.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Use a single literal key without spaces, quotes, or shell syntax.');
  }
  const path = credentialPath(env);
  let existing = '';
  try { existing = readFileSync(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const other = existing.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=/.test(line));
  while (other.at(-1) === '') other.pop();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(path), '.trashcompact-key-'));
  try {
    if (platform === 'win32') restrictAccess(staging, 'directory', { env });
    const file = join(staging, 'env');
    const descriptor = openSync(file, 'wx', 0o600);
    try {
      if (platform === 'win32') restrictAccess(file, 'file', { env });
      writeFileSync(descriptor, [...other, `TYPESAFE_API_KEY=${value}`, ''].join('\n'));
    } finally { closeSync(descriptor); }
    renameSync(file, path);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error();
    savePrivateKey(readFileSync(0, 'utf8'));
    console.log('API key saved privately. No API request was made.');
  } catch {
    console.error('Could not save API key privately. Check file permissions and use a single literal key without spaces, quotes, or shell syntax.');
    process.exitCode = 1;
  }
}
