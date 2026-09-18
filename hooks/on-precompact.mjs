#!/usr/bin/env node
// PreCompact hook: steer Claude Code's own summariser with the cached verdicts.
//
// Claude Code merges this hook's stdout into the compaction instructions, so what
// it prints decides what survives compaction. Runs strictly offline: every verdict
// was already paid for by the Stop hook, so compaction adds no latency and no cost.
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

const extra = (process.env.TRASHCOMPACT_FLAGS ?? "").split(" ").filter(Boolean);

const child = spawn(LAUNCHER, [transcript, "--precompact", ...extra], { stdio: ["ignore", "pipe", "ignore"] });
let steering = "";
child.stdout.on("data", (chunk) => { steering += chunk; });
child.on("close", () => {
  // Printing nothing leaves compaction exactly as it was — the safe default.
  if (steering.trim()) process.stdout.write(steering);
  process.exit(0);
});
