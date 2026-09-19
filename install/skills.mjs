// Manage only symlinks to this checkout. Existing real directories are user data.
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installerArgs } from './args.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'skill');
const { target: client, remove } = installerArgs(process.argv.slice(2));
const configHome = process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config');
const bases = client === 'codex' ? [join(process.env.HOME, '.agents'), process.env.CODEX_HOME || join(process.env.HOME, '.codex')] : client === 'claude' ? [join(process.env.HOME, '.claude')] : [join(configHome, "opencode")];
for (const base of new Set(bases)) {
  const parent = join(base, 'skills');
  const destination = join(parent, 'trashcompact');
  let stat;
  try { stat = lstatSync(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const owned = stat?.isSymbolicLink() && resolve(parent, readlinkSync(destination)) === target;
  if (remove) {
    if (owned) unlinkSync(destination);
    else if (stat) console.log(`Keeping existing skill: ${destination}`);
    continue;
  }
  if (stat) {
    if (!owned) console.log(`Keeping existing skill: ${destination}`);
    continue;
  }
  mkdirSync(parent, { recursive: true });
  symlinkSync(target, destination);
}
