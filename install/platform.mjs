import { existsSync, realpathSync } from 'node:fs';
import { dirname, delimiter, join, win32 } from 'node:path';

export const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const powershellQuote = value => "'" + value.replaceAll("'", "''") + "'";

export function powershellInvocation(executable, args) {
  const script = `& ${[executable, ...args].map(powershellQuote).join(' ')}; exit $LASTEXITCODE`;
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

export function hookInvocation(root, target, mode, platform = process.platform, node = process.execPath) {
  const paths = platform === 'win32' ? win32 : { join };
  const script = paths.join(root, 'hooks', `${target === 'claude' ? 'claude-' : ''}on-${mode}.mjs`);
  if (platform === 'win32') {
    if (target === 'claude') return { command: node, args: [script] };
    const command = ['powershell.exe', ...powershellInvocation(node, [script])].join(' ');
    return { command, commandWindows: command };
  }
  return { command: `${shellQuote(join(root, 'bin', 'trashcompact-hook'))} ${target === 'claude' ? 'claude-' : ''}${mode}` };
}

// npm's JS entry point avoids cmd.exe and its expansion of paths and arguments.
export function npmInvocation(env = process.env) {
  const candidates = [env.npm_execpath];
  for (const directory of [dirname(process.execPath), ...(env.PATH || env.Path || '').split(delimiter)]) {
    if (!directory) continue;
    candidates.push(join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    try { candidates.push(realpathSync(join(directory, 'npm'))); } catch {}
  }
  const script = candidates.find(path => path && /(?:^|[/\\])npm-cli\.js$/.test(path) && existsSync(path));
  if (!script) throw new Error('npm was not found. Install Node.js with npm, then rerun the installer.');
  return [process.execPath, [script]];
}
