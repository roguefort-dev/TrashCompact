#!/usr/bin/env node
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { powershellInvocation } from '../install/platform.mjs';

export async function checkCompatibility(target, env = process.env) {
  if (!['opencode', 'opencode2'].includes(target)) throw new Error('Target must be opencode or opencode2');
  let version;
  try {
    const executable = process.platform === 'win32' ? 'powershell.exe' : target;
    const args = process.platform === 'win32' ? powershellInvocation(target, ['--version']) : ['--version'];
    version = (await promisify(execFile)(executable, args, { env, timeout: 10000 })).stdout.trim();
  }
  catch { return { verified: false, reason: `${target} version could not be checked; restart a compatible OpenCode release after installation.` }; }
  if (version.includes('0.0.0-beta-19157')) throw new Error('OpenCode beta-19157 loads plugins but does not invoke the compaction hook. Install a current OpenCode 2 release (the plugin targets the 2.0.10 contract) before enabling TrashCompact.');
  const match = version.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:$|\s)/);
  if (match && Number(match[1]) === 1 && (Number(match[2]) < 18 || (Number(match[2]) === 18 && Number(match[3]) < 29))) throw new Error('TrashCompact requires OpenCode 1.18.29 or later for its server plugin export.');
  return { verified: false, reason: `Detected ${version}; compaction enrichment requires the documented plugin hook.` };
}

export async function installPlugin({ target, remove = false, configDir, env = process.env } = {}) {
  if (!['opencode', 'opencode2'].includes(target)) throw new Error('Target must be opencode or opencode2');
  const directory = configDir || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'opencode');
  const path = join(directory, 'plugins', 'trashcompact.js');
  const source = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'plugin.mjs')).href;
  const content = `// TrashCompact managed plugin loader\nexport { default } from ${JSON.stringify(source)};\n`;
  let existing;
  try { existing = await readFile(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing !== undefined && existing !== content) throw new Error(`Refusing to replace an unowned plugin: ${path}`);
  if (remove) { if (existing !== undefined) await unlink(path); }
  else if (existing === undefined) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  }
  return path;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--remove') options.remove = true;
      else if (args[i] === '--target') options.target = args[++i];
      else if (args[i] === '--config-dir') options.configDir = args[++i];
      else throw new Error(`Unknown option: ${args[i]}`);
    }
    if (!options.remove) { const compatibility = await checkCompatibility(options.target); console.error(compatibility.reason); }
    console.log(await installPlugin(options));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
