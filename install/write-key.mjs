// Private pipe helper for key.sh. No value is passed through argv or logging.
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
try {
  if (process.argv.length !== 2) throw new Error();
  const value = readFileSync(0, 'utf8');
  if (!value || /[\s'"`$;\\]/.test(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error();
  const path = process.env.TRASHCOMPACT_ENV || join(process.env.HOME, '.config/typesafe/env');
  let existing = '';
  try { existing = readFileSync(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const other = existing.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=/.test(line));
  while (other.at(-1) === '') other.pop();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(path), '.trashcompact-key-'));
  try {
    const file = join(staging, 'env');
    writeFileSync(file, [...other, `TYPESAFE_API_KEY=${value}`, ''].join('\n'), { mode: 0o600, flag: 'wx' });
    renameSync(file, path);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  console.log('API key saved privately (0600). No API request was made.');
} catch {
  console.error('Could not save API key. Use a single literal key without spaces, quotes, or shell syntax.');
  process.exitCode = 1;
}
