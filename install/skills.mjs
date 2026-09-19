// Manage only symlinks to this checkout. Existing real directories are user data.
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installerArgs } from './args.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'skill');
const { target: client, remove } = installerArgs(process.argv.slice(2));
const home = process.env.HOME || homedir();
const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
const bases = client === 'codex' ? [join(home, '.agents'), process.env.CODEX_HOME || join(home, '.codex')] : client === 'claude' ? [join(home, '.claude')] : [join(configHome, "opencode")];
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
  symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
}
