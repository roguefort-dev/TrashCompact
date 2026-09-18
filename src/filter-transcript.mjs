#!/usr/bin/env node
// Prune a Claude Code transcript with Jev.
//   Pass 0  code   collapse repeats that normalize to the same bytes; derive target keys
//   Pass 1  jev    retention score (drop transient status) + category for untargeted prose
//   Pass 2  jev    redundancy score (drop entries a later entry already says)
// Never mutates the input file.
//
// Incremental mode (--update) scores only entries that appeared since the last run.
// Retention is judged per entry and is final on arrival. Redundancy is directional —
// an entry is only ever compared against later entries sharing its target key — so a
// cached verdict is stale only when a NEW entry lands on that same key.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";

// Prefer this checkout own node_modules, so a fresh clone works with no global install.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SDK_CANDIDATES = [
  "@typesafe-ai/sdk",
  `${REPO_ROOT}/node_modules/@typesafe-ai/sdk/dist/index.mjs`,
  `${process.env.HOME}/.local/share/typesafe-cli/node_modules/@typesafe-ai/sdk/dist/index.mjs`,
];

async function loadSdk() {
  for (const specifier of SDK_CANDIDATES) {
    try {
      return await import(specifier);
    } catch {}
  }
  throw new Error(`Cannot find @typesafe-ai/sdk. Run:  npm install --prefix ${REPO_ROOT}`);
}

const RETENTION_LEVELS = [
  "Transient status with no lasting content: a command echo, a progress or completion ping, a bare exit code, a success line such as 'process finished' or 'done', a spinner, a timestamp, an empty result, or a restatement of what was just asked.",
  "Routine output whose specifics stop mattering once the step succeeded: a directory listing, a diff that was already applied, verbose logs of a step that passed, or narration of an action whose result is recorded elsewhere.",
  "Durable working knowledge a later reader would need and could not recover from surrounding entries: a decision and its reason, an error together with its cause, an API or data contract, an identifier referenced later, a constraint, a measurement that justifies a choice, or an unresolved problem.",
];

const REDUNDANCY_LEVELS = [
  "Everything this entry says is also said by at least one of the later entries. Re-reading it after them would add nothing. Wording, formatting, ordering, timestamps and line counts may differ; only the information carried matters.",
  "Most of this entry is repeated by the later entries, but it carries at least one specific fact, value, path or reason that none of them states.",
  "This entry carries substantive information that the later entries do not state at all.",
];

const CATEGORIES = {
  decision: "Commits to an approach, or records a choice between alternatives and why.",
  diagnosis: "Explains why something failed or behaves as it does.",
  plan: "Describes intended future steps that have not happened yet.",
  contract: "States an interface, schema, configuration or invariant.",
  result: "Reports an outcome, measurement, or test result.",
  narration: "Describes what is being done right now without adding a decision, cause, or contract.",
};

const DEFAULTS = {
  batch: 8, redundancyBatch: 4, keepTail: 20, chars: 1200, siblings: 3,
  threshold: 0.75, minConfidence: 0.55,
  redundancyThreshold: 0.6, redundancyConfidence: 0.7,
};

const STATE_HOME = `${process.env.HOME}/.claude/trashcompact`;
const PRECOMPACT_BUDGET = 6000;

function parseArguments(argv) {
  const options = {
    ...DEFAULTS, input: undefined, out: undefined, plan: false, digest: false, model: undefined,
    noDedup: false, update: false, offline: false, precompact: false, state: undefined, selfTest: false,
  };
  const numeric = new Set(["batch", "redundancy-batch", "keep-tail", "chars", "siblings", "threshold", "min-confidence", "redundancy-threshold", "redundancy-confidence"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const flag = argument.startsWith("--") ? argument.slice(2) : "";
    if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--plan") options.plan = true;
    else if (argument === "--digest") options.digest = true;
    else if (argument === "--no-dedup") options.noDedup = true;
    else if (argument === "--update") options.update = true;
    else if (argument === "--offline") options.offline = true;
    else if (argument === "--precompact") { options.precompact = true; options.offline = true; }
    else if (argument === "--state") options.state = argv[++index];
    else if (argument === "--out") options.out = argv[++index];
    else if (argument === "--model") options.model = argv[++index];
    else if (numeric.has(flag)) {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value)) throw new Error(`--${flag} needs a number.`);
      options[flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else if (!argument.startsWith("-") || argument === "-") options.input = argument;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.selfTest) return options;
  if (!options.input) throw new Error("Give a transcript path, or - for stdin.");
  if (options.update && options.input === "-") throw new Error("--update needs a real transcript path, not stdin.");
  if (!options.state && options.input !== "-") {
    options.state = `${STATE_HOME}/${basename(options.input).replace(/\.jsonl$/, "")}.json`;
  }
  return options;
}

// ---- verdict cache ---------------------------------------------------------
// Keyed by entry uuid so it survives the transcript growing underneath it.
// Stores raw verdicts, never the removal decision: thresholds stay retunable
// without paying to re-judge anything.

function loadState(path) {
  const empty = { version: 1, anchor: null, verdicts: {}, usage: { requests: 0, input: 0 }, runs: 0 };
  if (!path || !existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed?.version === 1 && parsed.verdicts ? { ...empty, ...parsed } : empty;
  } catch {
    return empty;
  }
}

function saveState(path, state) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (block?.type === "text") return block.text ?? "";
    if (block?.type === "thinking") return block.thinking ?? "";
    if (block?.type === "tool_use") return `[${block.name}] ${JSON.stringify(block.input ?? {}).slice(0, 400)}`;
    if (block?.type === "tool_result") {
      const inner = block.content;
      if (typeof inner === "string") return inner;
      if (Array.isArray(inner)) return inner.map((part) => part?.text ?? "").join("\n");
    }
    return "";
  }).join("\n").trim();
}

const isUserTurn = (entry) => entry.type === "user" && typeof entry.message?.content === "string";

function classifyKind(entry) {
  if (entry.type !== "assistant" && entry.type !== "user") return "other";
  if (isUserTurn(entry)) return "user";
  const blocks = entry.message?.content;
  if (!Array.isArray(blocks)) return "other";
  const types = new Set(blocks.map((block) => block?.type));
  if (types.has("tool_result")) return "tool_result";
  if (types.has("thinking")) return "thinking";
  if (types.has("tool_use")) return "tool_use";
  if (types.has("text")) return "assistant_text";
  return "other";
}

// Volatile detail that differs between two otherwise identical outputs.
function normalize(text) {
  return text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, "<ts>")
    .replace(/\b\d+(\.\d+)?\s?(ms|s|kB|MB|GB)\b/g, "<n>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Target key: what an entry is about. Parsed, never judged.
function targetKey(record, toolByUseId) {
  if (record.kind === "tool_result") {
    const block = (record.entry.message?.content ?? []).find((candidate) => candidate?.type === "tool_result");
    const tool = toolByUseId.get(block?.tool_use_id);
    if (tool) {
      const input = tool.input ?? {};
      const subject = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url ?? "";
      return `tool:${tool.name}:${String(subject).slice(0, 120)}`;
    }
    return "tool:unknown";
  }
  return null; // prose: keyed by category from Pass 1
}

function loadRecords(input) {
  const raw = input === "-" ? readFileSync(0, "utf8") : readFileSync(input, "utf8");
  const toolByUseId = new Map();
  const records = raw.split("\n").filter((line) => line.trim()).map((line, index) => {
    let entry;
    try { entry = JSON.parse(line); } catch { entry = { type: "unparsed" }; }
    return { index, entry, raw: line };
  });
  for (const record of records) {
    for (const block of record.entry.message?.content ?? []) {
      if (block?.type === "tool_use" && block.id) toolByUseId.set(block.id, { name: block.name, input: block.input });
    }
  }
  for (const record of records) {
    record.kind = classifyKind(record.entry);
    record.text = textOf(record.entry.message?.content);
    record.key = targetKey(record, toolByUseId);
    record.id = record.entry.uuid ?? createHash("sha1").update(record.raw).digest("hex").slice(0, 16);
    const blocks = Array.isArray(record.entry.message?.content) ? record.entry.message.content : [];
    record.issuedIds = blocks.filter((b) => b?.type === "tool_use" && b.id).map((b) => b.id);
    record.answersId = blocks.find((b) => b?.type === "tool_result")?.tool_use_id;
  }
  return records;
}

// Pass 0: among entries that normalize identically, keep only the last.
function exactDedup(records) {
  const lastByHash = new Map();
  for (const record of records) {
    // tool_use entries pair with their results; collapsing them would orphan a result.
    if (!record.text || record.kind === "user" || record.kind === "other" || record.kind === "tool_use") continue;
    const hash = createHash("sha1").update(normalize(record.text)).digest("hex");
    record.hash = hash;
    lastByHash.set(hash, record.index);
  }
  const removed = [];
  for (const record of records) {
    if (record.hash && lastByHash.get(record.hash) !== record.index) {
      record.removed = "exact-repeat";
      removed.push(record);
    }
  }
  return removed;
}

function selectCandidates(records, keepTail) {
  const cutoff = records.length - keepTail;
  const candidates = [];
  const forced = new Set();
  for (const record of records) {
    if (record.removed) continue;
    if (record.index >= cutoff || record.kind === "user" || record.kind === "other" || record.kind === "tool_use") {
      forced.add(record.index);
      continue;
    }
    if (record.text.length) candidates.push(record);
    else record.removed = "empty";
  }
  return { candidates, forced };
}

const chunk = (items, size) => {
  const out = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
};

async function runPass1(client, sdk, candidates, options, usage) {
  const { score, choice } = sdk;
  for (const [position, batch] of chunk(candidates, options.batch).entries()) {
    process.stderr.write(`\rpass 1 — retention  batch ${position + 1}/${Math.ceil(candidates.length / options.batch)}`);
    const state = { entries: {} };
    const questions = {};
    for (const record of batch) {
      const id = `e${record.index}`;
      state.entries[id] = { kind: record.kind, text: record.text.slice(0, options.chars) };
      questions[`r_${id}`] = score(
        `Rate only the entry at \`entries.${id}\`, for a reader pruning a coding-session transcript. The other entries are context and must not change its rating.`,
        RETENTION_LEVELS,
      );
      // Untargeted prose needs a category to block on in pass 2. Same state, so near-free.
      if (record.key === null) {
        questions[`c_${id}`] = choice(`What does the entry at \`entries.${id}\` primarily do?`, CATEGORIES);
      }
    }
    const result = await client.systemOne({ state, questions });
    usage.input += result.usage.input_tokens;
    usage.output += result.usage.output_tokens;
    usage.requests += 1;
    for (const record of batch) {
      const retention = result.answers[`r_e${record.index}`];
      record.retention = { score: retention.score, confidence: retention.confidence };
      const category = result.answers[`c_e${record.index}`];
      if (category) record.key = `prose:${category.choice}`;
    }
  }
}

// Shortlist in code: later entries sharing this entry's target key.
// `cached` lets an incremental run skip any entry already judged against the
// same newest sibling — the only thing that can invalidate a verdict is a
// later arrival on that key.
function buildRedundancyJobs(survivors, options, cached = null) {
  const byKey = new Map();
  for (const record of survivors) {
    if (!record.key) continue;
    if (!byKey.has(record.key)) byKey.set(record.key, []);
    byKey.get(record.key).push(record);
  }
  const jobs = [];
  for (const group of byKey.values()) {
    group.sort((a, b) => a.index - b.index);
    for (let position = 0; position < group.length - 1; position += 1) {
      const record = group[position];
      const later = group.slice(position + 1).slice(-options.siblings);
      const newest = later[later.length - 1].index;
      if (cached && (cached[record.id]?.judgedAgainst ?? -1) >= newest) continue;
      jobs.push({ record, later, newest });
    }
  }
  return jobs;
}

async function runPass2(client, sdk, jobs, options, usage) {
  const { score } = sdk;
  for (const [position, batch] of chunk(jobs, options.redundancyBatch).entries()) {
    process.stderr.write(`\rpass 2 — redundancy batch ${position + 1}/${Math.ceil(jobs.length / options.redundancyBatch)}`);
    const state = { groups: {} };
    const questions = {};
    for (const job of batch) {
      const id = `g${job.record.index}`;
      state.groups[id] = {
        entry: job.record.text.slice(0, options.chars),
        later_entries: job.later.map((sibling) => sibling.text.slice(0, options.chars)),
      };
      questions[id] = score(
        `Compare \`groups.${id}.entry\` against \`groups.${id}.later_entries\`, which came after it in the same session and concern the same thing. Rate how much of the entry's information the later entries already carry. Judge only this group.`,
        REDUNDANCY_LEVELS,
      );
    }
    const result = await client.systemOne({ state, questions });
    usage.input += result.usage.input_tokens;
    usage.output += result.usage.output_tokens;
    usage.requests += 1;
    for (const job of batch) {
      const answer = result.answers[`g${job.record.index}`];
      job.record.redundancy = { score: answer.score, confidence: answer.confidence };
      job.record.judgedAgainst = job.newest;
    }
  }
  return jobs.length;
}

// Thresholds are applied fresh every run, so retuning them costs nothing.
function applyRetention(candidates, options) {
  for (const record of candidates) {
    const verdict = record.retention;
    if (verdict && verdict.score < options.threshold && verdict.confidence >= options.minConfidence) {
      record.removed = `noise ${verdict.score.toFixed(2)}/${verdict.confidence.toFixed(2)}`;
    }
  }
}

function applyRedundancy(candidates, options) {
  for (const record of candidates) {
    if (record.removed) continue;
    const verdict = record.redundancy;
    if (verdict && verdict.score < options.redundancyThreshold && verdict.confidence >= options.redundancyConfidence) {
      record.removed = `redundant ${verdict.score.toFixed(2)}/${verdict.confidence.toFixed(2)}`;
    }
  }
}

// Steering for Claude Code's own summariser, which already has the full
// conversation — so this names what must survive rather than restating it.
function precompactInstructions(records, options) {
  const kept = records.filter((record) => !record.removed && record.text?.length);
  const ranked = [...kept].sort((a, b) => (b.retention?.score ?? 1) - (a.retention?.score ?? 1) || b.index - a.index);
  const chosen = [];
  let budget = PRECOMPACT_BUDGET;
  for (const record of ranked) {
    const line = `- (${record.kind}) ${record.text.replace(/\s+/g, " ").slice(0, 280)}`;
    if (line.length > budget) continue;
    budget -= line.length;
    chosen.push({ record, line });
  }
  chosen.sort((a, b) => a.record.index - b.record.index);
  const dropped = records.filter((record) => record.removed).length;
  if (!chosen.length) return "";
  return (
    `A separate pass over this session's transcript scored every entry for durable working knowledge ` +
    `and found ${dropped} of ${records.length} entries to be transient status or information a later ` +
    `entry already carries. Do not spend summary space on those.\n\n` +
    `These entries carry the session's durable content. Preserve their substance — decisions and their ` +
    `reasons, errors and their causes, contracts, identifiers, and unresolved problems — in the summary:\n\n` +
    `${chosen.map((item) => item.line).join("\n")}\n`
  );
}

// Cheapest possible live call: proves the key and the network path, nothing more.
async function selfTest(options) {
  const sdk = await loadSdk();
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set.");
  const client = new sdk.TypeSafeClient(options.model ? { defaultModel: options.model } : {});
  const result = await client.systemOne({
    state: { probe: "a build log line reading: process finished with exit code 0" },
    questions: { transient: sdk.noul("Is `probe` a transient status line with no lasting content?") },
  });
  process.stdout.write(`ok \u2014 noul ${result.answers.transient.noul.toFixed(2)}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) return selfTest(options);
  const records = loadRecords(options.input);
  const state = loadState(options.state);
  const exactRemoved = exactDedup(records);
  const { candidates, forced } = selectCandidates(records, options.keepTail);
  const totalChars = records.reduce((sum, record) => sum + (record.text?.length ?? 0), 0);

  // Replay what past runs already judged. Entry uuids are stable across appends.
  let reused = 0;
  for (const record of records) {
    const cached = state.verdicts[record.id];
    if (!cached) continue;
    if (cached.retention) { record.retention = cached.retention; reused += 1; }
    if (cached.redundancy) record.redundancy = cached.redundancy;
    if (cached.judgedAgainst !== undefined) record.judgedAgainst = cached.judgedAgainst;
    if (cached.key && record.key === null) record.key = cached.key; // prose category, judged once
  }
  const unscored = candidates.filter((record) => !record.retention);

  if (options.plan) {
    const keyed = candidates.filter((record) => record.key).length;
    process.stdout.write(
      `entries          ${records.length}\n` +
      `pass 0 removed   ${exactRemoved.length} (normalize to an earlier entry)\n` +
      `kept by rule     ${forced.size} (user turns, last ${options.keepTail}, structural)\n` +
      `cached verdicts  ${reused} reused from ${options.state ?? "(no state file)"}\n` +
      `pass 1 judges    ${unscored.length} in ${Math.ceil(unscored.length / options.batch)} requests (batch ${options.batch})\n` +
      `  with a target  ${keyed} (tool results); ${candidates.length - keyed} prose get a category\n` +
      `transcript       ${totalChars.toLocaleString()} chars\n` +
      `pass 1 payload   ~${unscored.reduce((s, r) => s + Math.min(r.text.length, options.chars), 0).toLocaleString()} chars\n`,
    );
    return;
  }

  const usage = { input: 0, output: 0, requests: 0 };
  let comparisons = 0;

  if (options.offline) {
    applyRetention(candidates, options);
  } else {
    const sdk = await loadSdk();
    if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set.");
    const client = new sdk.TypeSafeClient(options.model ? { defaultModel: options.model } : {});
    if (unscored.length) await runPass1(client, sdk, unscored, options, usage);
    applyRetention(candidates, options);
    if (!options.noDedup) {
      const survivors = candidates.filter((record) => !record.removed);
      const jobs = buildRedundancyJobs(survivors, options, state.verdicts);
      comparisons = jobs.length;
      if (jobs.length) await runPass2(client, sdk, jobs, options, usage);
    }
  }
  applyRedundancy(candidates, options);
  process.stderr.write("\r\x1b[K");

  // A call whose every result was removed carries nothing on its own.
  const survivingAnswers = new Set(records.filter((r) => !r.removed && r.answersId).map((r) => r.answersId));
  for (const record of records) {
    if (record.removed || record.kind !== "tool_use" || !record.issuedIds?.length) continue;
    if (!record.issuedIds.some((id) => survivingAnswers.has(id))) record.removed = "orphan-call";
  }

  if (options.state && !options.offline) {
    for (const record of records) {
      if (!record.retention && !record.redundancy) continue;
      state.verdicts[record.id] = {
        index: record.index,
        kind: record.kind,
        ...(record.key && { key: record.key }),
        ...(record.retention && { retention: record.retention }),
        ...(record.redundancy && { redundancy: record.redundancy }),
        ...(record.judgedAgainst !== undefined && { judgedAgainst: record.judgedAgainst }),
      };
    }
    state.anchor = records[0]?.id ?? null;
    state.scanned = records.length;
    state.runs += 1;
    state.usage.requests += usage.requests;
    state.usage.input += usage.input;
    state.updated = new Date().toISOString();
    saveState(options.state, state);
  }

  const kept = records.filter((record) => !record.removed);
  const removed = records.filter((record) => record.removed);
  const keptChars = kept.reduce((sum, record) => sum + (record.text?.length ?? 0), 0);

  if (options.precompact) {
    process.stdout.write(precompactInstructions(records, options));
    return;
  }
  if (options.update) {
    process.stderr.write(
      `trashcompact: +${unscored.length} scored, ${reused} cached, ${comparisons} redundancy comparisons, ` +
      `${usage.requests} requests, ~$${((usage.input / 1e6) * 0.042).toFixed(4)}\n`,
    );
    return;
  }

  const body = options.digest
    ? kept.filter((record) => record.text?.length).map((record) => `## ${record.kind} (e${record.index})\n\n${record.text}`).join("\n\n")
    : kept.map((record) => record.raw).join("\n");

  if (options.out) writeFileSync(options.out, `${body}\n`);
  else process.stdout.write(`${body}\n`);

  const tally = {};
  for (const record of removed) {
    const reason = record.removed.split(" ")[0];
    tally[reason] = (tally[reason] ?? 0) + 1;
  }
  process.stderr.write(
    `\nentries  ${records.length} → ${kept.length}  (removed ${removed.length}: ` +
    `${Object.entries(tally).map(([reason, count]) => `${count} ${reason}`).join(", ") || "none"})\n` +
    `chars    ${totalChars.toLocaleString()} → ${keptChars.toLocaleString()}  (${(100 - (keptChars / Math.max(totalChars, 1)) * 100).toFixed(1)}% smaller)\n` +
    `jev      ${usage.requests} requests, ${usage.input.toLocaleString()} input tokens` +
    `${comparisons ? `, ${comparisons} redundancy comparisons` : ""}\n` +
    `cost     ~$${((usage.input / 1e6) * 0.042).toFixed(4)} at $0.042/Mtok\n` +
    `${options.out ? `written  ${options.out}\n` : ""}`,
  );
}

main().catch((error) => {
  process.stderr.write(`trashcompact: ${error.message}\n`);
  process.exit(1);
});
