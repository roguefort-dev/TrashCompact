#!/usr/bin/env node
// Stop hook: score the entries this turn just appended, and nothing else.
//
// Runs with async:true so it never sits in the turn's critical path. A turn that
// appended nothing costs zero API requests — the verdict cache short-circuits it.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", "trashcompact");

const readStdin = async () => {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
};

const input = JSON.parse((await readStdin()) || "{}");
const transcript = input.transcript_path;
if (!transcript) process.exit(0);

// Extra flags for the scoring pass, e.g. TRASHCOMPACT_FLAGS="--keep-tail 40"
const extra = (process.env.TRASHCOMPACT_FLAGS ?? "").split(" ").filter(Boolean);

const child = spawn(LAUNCHER, [transcript, "--update", ...extra], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.on("close", (code) => {
  // A scoring failure must never disrupt the session; surface it quietly and move on.
  if (code !== 0 && stderr.trim()) {
    process.stdout.write(JSON.stringify({ suppressOutput: true, systemMessage: `TrashCompact: ${stderr.trim().split("\n").pop()}` }));
  }
  process.exit(0);
});
