#!/usr/bin/env node
// Merge (or remove) the TrashCompact hooks in ~/.claude/settings.json.
//
// Only ever touches the two hook entries it owns: everything else in the file is
// read, preserved, and written back untouched. A broken settings.json silently
// disables every setting in it, so the write is atomic and validated first.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SETTINGS = join(process.env.HOME, ".claude", "settings.json");
const OWNED = ["hooks/on-stop.mjs", "hooks/on-precompact.mjs"];
const remove = process.argv.includes("--remove");

const entries = {
  Stop: {
    hooks: [{
      type: "command",
      command: `${join(ROOT, "bin", "trashcompact-hook")} stop`,
      async: true,
      timeout: 120,
      statusMessage: "TrashCompact: scoring new entries",
    }],
  },
  PreCompact: {
    hooks: [{
      type: "command",
      command: `${join(ROOT, "bin", "trashcompact-hook")} precompact`,
      timeout: 30,
      statusMessage: "TrashCompact: steering compaction",
    }],
  },
};

const isOurs = (group) =>
  (group.hooks ?? []).some((hook) =>
    typeof hook.command === "string" &&
    (OWNED.some((name) => hook.command.includes(name)) || hook.command.includes("trashcompact-hook")));

let settings = {};
if (existsSync(SETTINGS)) {
  try {
    settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch (error) {
    console.error(`refusing to touch a settings.json that does not parse: ${error.message}`);
    process.exit(1);
  }
}

settings.hooks ??= {};
for (const event of Object.keys(entries)) {
  const existing = (settings.hooks[event] ?? []).filter((group) => !isOurs(group));
  const next = remove ? existing : [...existing, entries[event]];
  if (next.length) settings.hooks[event] = next;
  else delete settings.hooks[event];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

const serialized = `${JSON.stringify(settings, null, 2)}\n`;
JSON.parse(serialized); // never write something we cannot read back
mkdirSync(dirname(SETTINGS), { recursive: true });
const staging = `${SETTINGS}.trashcompact.tmp`;
writeFileSync(staging, serialized);
renameSync(staging, SETTINGS);

console.log(remove ? "removed Stop and PreCompact hooks" : "wired Stop (async) and PreCompact hooks");
