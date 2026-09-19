#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const offline = args.some(arg => ['--offline', '--precompact', '--plan', '--recovery'].includes(arg));
try {
  if (!offline && !process.env.TYPESAFE_API_KEY) {
    const path = process.env.TRASHCOMPACT_ENV || join(process.env.HOME || '', '.config/typesafe/env');
    let raw = '';
    try { raw = readFileSync(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Accept one literal assignment, optionally quoted. Never source shell code.
    const lines = raw.split(/\r?\n/).filter(line => /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=/.test(line));
    if (lines.length > 1) throw new Error('Duplicate key assignment');
    if (lines.length) {
      let value = lines[0].replace(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*/, '').trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!value || /[\s'"`$;\\]/.test(value)) throw new Error('Invalid key assignment');
      process.env.TYPESAFE_API_KEY = value;
    }
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const child = spawn(process.execPath, [join(root, 'src/filter-transcript.mjs'), ...args], { stdio: 'inherit' });
  child.on('error', () => { process.stderr.write('trashcompact: unable to start filter\n'); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} catch {
  process.stderr.write('trashcompact: unable to load API key configuration\n');
  process.exitCode = 1;
}
