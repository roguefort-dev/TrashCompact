#!/usr/bin/env node
// Inspect a Codex rollout or legacy Claude transcript for conservative compaction.
//
//   window       code  select a conservative transcript window from boundary evidence
//   classify     code  one category per entry (src/classify.mjs)
//   policies     code  supersession, half-life, duplicate payloads
//   judge        jev   retention score for the prose that survives
//
// Never mutates the input file.
//
// The product is the PreCompact steering text, not a smaller file. `--out` writes a
// filtered JSONL, but nothing in production reads it; it exists so the rules above can
// be inspected against a real transcript.
//
// Incremental mode reuses verdicts only when content and judging configuration match.
// Long entries and uncertain or invalid verdicts are retained conservatively.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, renameSync, rmSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";
import { CATEGORY, POLICY, classify, applyPolicies, liveWindowStart } from "./classify.mjs";
import { prepareRecoveryRanking, scoreRecoveryRanking, rankedPassages } from "./recovery-rank.mjs";
import { detectFormat, classifyCodex, codexTool, recoveryEvidence } from "./codex.mjs";
import { pruneToolExchanges } from "./static-tools.mjs";

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

// The label an entry carries into the steering text. Asked as a second question in the
// same request as the score, against the same state; it is only a display label.
const CATEGORIES = {
  decision: "Commits to an approach, or records a choice between alternatives and why.",
  diagnosis: "Explains why something failed or behaves as it does.",
  plan: "Describes intended future steps that have not happened yet.",
  contract: "States an interface, schema, configuration or invariant.",
  result: "Reports an outcome, measurement, or test result.",
  narration: "Describes what is being done right now without adding a decision, cause, or contract.",
};

const DEFAULTS = {
  batch: 8, keepTail: 20, chars: 1200,
  threshold: 0.75, minConfidence: 0.55,
};

const STATE_HOME = `${process.env.CODEX_HOME || `${process.env.HOME}/.codex`}/trashcompact`;
const PRECOMPACT_BUDGET = 6000;

// Pass 2 (redundancy) is retired: it asked "does a later entry say the same thing?"
// when the useful relation is supersession, which code decides for free. Its flags are
// still accepted so an existing TRASHCOMPACT_FLAGS does not start failing hooks.
const RETIRED_VALUE_FLAGS = new Set(["redundancy-threshold", "redundancy-confidence", "redundancy-batch", "siblings"]);
const RETIRED_BARE_FLAGS = new Set(["no-dedup"]);

function parseArguments(argv) {
  const options = {
    ...DEFAULTS, input: undefined, out: undefined, plan: false, digest: false, model: process.env.TYPESAFE_DEFAULT_MODEL || "jev-1.13.0",
    format: "auto", recoveryRank: false, recovery: false, update: false, offline: false, precompact: false, state: undefined, selfTest: false, fullLog: false,
  };
  const numeric = new Set(["batch", "keep-tail", "chars", "threshold", "min-confidence"]);
  const retired = [];
  const valueAfter = (index, flag) => {
    const value = argv[index];
    if (!value || value.startsWith("--")) throw new Error(`--${flag} needs a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const flag = argument.startsWith("--") ? argument.slice(2) : "";
    if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--plan") options.plan = true;
    else if (argument === "--digest") options.digest = true;
    else if (argument === "--update") options.update = true;
    else if (argument === "--offline") options.offline = true;
    else if (argument === "--full-log") options.fullLog = true;
    else if (argument === "--recovery-rank") options.recoveryRank = true;
    else if (argument === "--recovery") { options.recovery = true; options.offline = true; }
    else if (argument === "--format") options.format = valueAfter(++index, "format");
    else if (argument === "--precompact") { options.precompact = true; options.offline = true; }
    else if (argument === "--state") options.state = valueAfter(++index, "state");
    else if (argument === "--out") options.out = valueAfter(++index, "out");
    else if (argument === "--model") options.model = valueAfter(++index, "model");
    else if (RETIRED_VALUE_FLAGS.has(flag)) { valueAfter(++index, flag); retired.push(flag); }
    else if (RETIRED_BARE_FLAGS.has(flag)) retired.push(flag);
    else if (numeric.has(flag)) {
      const value = Number(valueAfter(++index, flag));
      if (!Number.isFinite(value)) throw new Error(`--${flag} needs a finite number.`);
      if (["batch", "chars", "keep-tail"].includes(flag) && (!Number.isSafeInteger(value) || value < (flag === "keep-tail" ? 0 : 1)))
        throw new Error(`--${flag} needs a ${flag === "keep-tail" ? "nonnegative" : "positive"} integer.`);
      if ((flag === "threshold" && (value < 0 || value > 2)) || (flag === "min-confidence" && (value < 0 || value > 1)))
        throw new Error(`--${flag} is outside its supported range.`);
      options[flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else if (!argument.startsWith("-") || argument === "-") {
      if (options.input) throw new Error("Give exactly one transcript path.");
      options.input = argument;
    }
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!["auto", "codex", "claude"].includes(options.format)) throw new Error("--format must be auto, codex, or claude.");
  if (retired.length) {
    process.stderr.write(`trashcompact: ignoring retired flag(s): ${retired.map((f) => `--${f}`).join(", ")}\n`);
  }
  if (options.batch > 32 || options.chars > 32000 || options.batch * options.chars > 32000)
    throw new Error("Keep batch <= 32, chars <= 32000, and batch * chars <= 32000.");
  if (options.selfTest && (options.offline || options.plan || options.update || options.digest || options.out))
    throw new Error("--self-test cannot be combined with offline, precompact, plan, update, digest, or output modes.");
  if (options.selfTest) return options;
  if (!options.input) throw new Error("Give a transcript path, or - for stdin.");
  if (options.update && options.input === "-") throw new Error("--update needs a real transcript path, not stdin.");
  if (!options.state && options.input !== "-") {
    const identity = existsSync(options.input) ? realpathSync(options.input) : resolve(options.input);
    options.state = `${STATE_HOME}/${createHash("sha256").update(identity).digest("hex")}.json`;
  }
  const paths = [options.input === "-" ? null : options.input, options.out, options.state].filter(Boolean);
  const canonical = (path) => {
    if (existsSync(path)) return realpathSync(path);
    const parent = dirname(resolve(path));
    return parent === resolve(path) ? resolve(path) : `${canonical(parent)}/${basename(path)}`;
  };
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const a = existsSync(paths[i]) ? statSync(paths[i]) : null;
    const b = existsSync(paths[j]) ? statSync(paths[j]) : null;
    if (canonical(paths[i]) === canonical(paths[j]) || (a && b && a.dev === b.dev && a.ino === b.ino))
      throw new Error("Input, output, and state must be different files.");
  }
  return options;
}

// ---- verdict cache ---------------------------------------------------------
// Keyed by full content and judging configuration, independent of transcript appends.
// Stores raw verdicts, never the removal decision: thresholds stay retunable
// without paying to re-judge anything.

function loadState(path) {
  const empty = { version: 2, anchor: null, verdicts: {}, usage: { requests: 0, input: 0 }, runs: 0 };
  if (!path || !existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed?.version === 2 && parsed.verdicts && typeof parsed.verdicts === "object" && !Array.isArray(parsed.verdicts)
      ? { ...empty, ...parsed } : empty;
  } catch { return empty; }
}

// Lock only the read/merge/rename transaction, never the remote request. A competing
// writer fails safely without overwriting its cache. A stale lock requires removal.
function saveState(path, state, delta = { requests: 0, input: 0 }) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  try { mkdirSync(lock); } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Cache is locked by another writer: ${path}`);
    throw error;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const current = loadState(path);
    const counter = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
    const merged = { ...state, verdicts: { ...current.verdicts, ...state.verdicts },
      recoveryRank: { version: 1,
        passages: { ...current.recoveryRank?.passages, ...state.recoveryRank?.passages },
        relations: { ...current.recoveryRank?.relations, ...state.recoveryRank?.relations } },
      runs: counter(current.runs) + 1,
      usage: { requests: counter(current.usage?.requests) + counter(delta.requests), input: counter(current.usage?.input) + counter(delta.input) } };
    writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

const validRetention = (value) => Number.isFinite(value?.score) && value.score >= 0 && value.score <= 2 &&
  Number.isFinite(value?.confidence) && value.confidence >= 0 && value.confidence <= 1;
const RETENTION_PROMPT = (id) => `Rate only the entry at \`entries.${id}\`, for a reader pruning a coding-session transcript. The other entries are context and must not change its rating.`;
function verdictKey(record, options) {
  return createHash("sha256").update(JSON.stringify({
    version: 2, content: record.entry, text: record.text, category: record.category,
    model: options.model ?? "server-default", chars: options.chars,
    prompt: RETENTION_PROMPT("entry"), levels: RETENTION_LEVELS, categories: CATEGORIES,
  })).digest("hex");
}

// Human turns provide reporting and a boundary for adjacent repeat detection.
const TURN_MARKER = new Set([CATEGORY.HUMAN_INSTRUCTION, CATEGORY.HUMAN_NUDGE]);

// Only known visible Claude content is eligible for recovery. Tool results arrive
// in user envelopes but must never be attributed as user instructions.
function claudeRecovery(entry) {
  const content = entry.message?.content;
  const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content : [];
  const text = block => typeof block === 'string' || (block?.type === 'text' && typeof block.text === 'string' && Object.keys(block).every(key => ['type', 'text'].includes(key)));
  const visible = ['user', 'assistant'].includes(entry.type) && blocks.length && !entry.isSidechain && !entry.isMeta;
  if (visible && blocks.every(text)) return { role: entry.type, recoveryExcluded: false };
  const result = block => block?.type === 'tool_result' && Object.keys(block).every(key => ['type', 'tool_use_id', 'content', 'is_error'].includes(key)) &&
    (typeof block.content === 'string' || (Array.isArray(block.content) && block.content.every(text)));
  if (visible && entry.type === 'user' && blocks.every(result)) return { role: 'tool', recoveryExcluded: false };
  return { recoveryExcluded: true };
}

// Select records using conservative boundary evidence. A transcript cannot prove
// exactly what the runtime currently has in context; ambiguous histories retain all.
function loadRecords(input, { fullLog = false, format = "auto" } = {}) {
  const raw = input === "-" ? readFileSync(0, "utf8") : readFileSync(input, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  const entries = lines.map((line, index) => {
    let entry;
    try { entry = JSON.parse(line); } catch { throw new Error(`Invalid JSON at nonempty record ${index + 1}; refusing to drop unreadable transcript data.`); }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid transcript object at record ${index + 1}.`);
    return entry;
  });

  const detectedFormat = format === "auto" ? detectFormat(entries) : format;
  // Built over the whole file: a result in the window can answer a call issued before it.
  const toolByUseId = new Map();
  for (const entry of entries) {
    if (detectedFormat === "codex") {
      const tool = codexTool(entry);
      if (tool?.id) toolByUseId.set(tool.id, tool);
      continue;
    }
    const blocks = entry.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type === "tool_use" && block.id) toolByUseId.set(block.id, { name: block.name, input: block.input });
    }
  }

  const start = fullLog ? 0 : liveWindowStart(entries);
  const records = [];
  let turn = 0;
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    const verdict = detectedFormat === "codex" ? classifyCodex(entry, toolByUseId) : classify(entry, toolByUseId);
    if (TURN_MARKER.has(verdict.category)) turn += 1;
    const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
    records.push({
      index,
      entry,
      raw: lines[index],
      turn,
      ...verdict,
      ...(detectedFormat === "claude" ? claudeRecovery(entry) : {}),
      format: detectedFormat,
      id: entry.uuid ?? createHash("sha1").update(lines[index]).digest("hex").slice(0, 16),
      issuedIds: verdict.issuedIds ?? blocks.filter((block) => block?.type === "tool_use" && block.id).map((block) => block.id),
      answersIds: verdict.answersIds ?? blocks.filter((block) => block?.type === "tool_result" && block.tool_use_id).map((block) => block.tool_use_id),
    });
  }
  return { records, start, totalEntries: entries.length, totalTurns: turn, format: detectedFormat };
}

// Only adjacent assistant prose in the same human turn can be collapsed. Compare
// the complete message payload: whitespace, case, measurements and IDs are evidence.
function dedupPayloads(records) {
  let removed = 0;
  const assistantPayload = (record) => record.format === 'codex'
    ? record.entry.type === 'response_item' && record.entry.payload?.type === 'message' && record.entry.payload.role === 'assistant' ? record.entry.payload : null
    : record.entry.type === 'assistant' ? record.entry.message : null;
  for (let index = 0; index + 1 < records.length; index++) {
    const record = records[index], next = records[index + 1];
    const payload = assistantPayload(record), nextPayload = assistantPayload(next);
    if (record.protected || record.category !== CATEGORY.PROSE || next.category !== CATEGORY.PROSE ||
        !payload || !nextPayload || record.turn !== next.turn) continue;
    if (JSON.stringify(payload) === JSON.stringify(nextPayload)) {
      record.removed = "exact-repeat";
      removed++;
    }
  }
  return removed;
}

function protectRecords(records, keepTail) {
  const answered = new Set(records.flatMap((r) => r.answersIds ?? []));
  records.forEach((record, index) => {
    record.tailProtected = index >= records.length - keepTail;
    record.protected = record.tailProtected || POLICY[record.category]?.pinned ||
      record.pinned || record.category === CATEGORY.HUMAN_INSTRUCTION ||
      record.issuedIds?.some((id) => !answered.has(id));
  });
}

// Remove proven redundant tool pairs before local metadata and empty records.
// Already removed entries stay hidden from subsequent policy checks.
function runPolicies(records, keepTail) {
  pruneToolExchanges(records, keepTail);
  const totalTurns = records.length ? records[records.length - 1].turn : 0;
  const masked = records.map((record) =>
    record.removed ? { category: CATEGORY.EMPTY, supersedeKey: null } : record);
  const drops = applyPolicies(masked, {
    turnOf: (index) => records[index].turn,
    totalTurns,
    keepTail,
    total: records.length,
  });
  for (const [index, reason] of drops) {
    if (!records[index].removed && !records[index].protected) records[index].removed = reason;
  }
}

const chunk = (items, size) => {
  const out = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
};

async function runPass1(client, sdk, candidates, options, usage) {
  const { score, choice } = sdk;
  const batches = chunk(candidates.filter((r) => !r.removed && r.category === CATEGORY.PROSE && !r.pinned && !r.protected && r.text.length <= options.chars), options.batch);
  for (let position = 0; position < batches.length; position++) {
    const batch = batches[position];
    const state = { entries: {} };
    const questions = {};
    for (const record of batch) {
      const id = `e${record.index}`;
      state.entries[id] = { kind: record.category, text: record.text.slice(0, options.chars) };
      questions[`r_${id}`] = score(
        RETENTION_PROMPT(id),
        RETENTION_LEVELS,
      );
      questions[`c_${id}`] = choice(`What does the entry at \`entries.${id}\` primarily do?`, CATEGORIES);
    }
    // UTF-8 and question overhead can exceed a character-only estimate. Split the
    // batch; keep a single oversize entry intact without submitting its prefix.
    if (Buffer.byteLength(JSON.stringify({ state, questions }), "utf8") > 30000) {
      if (batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        batches.splice(position, 1, batch.slice(0, middle), batch.slice(middle));
        position--;
      }
      continue;
    }
    process.stderr.write(`\rjudging prose  batch ${position + 1}/${batches.length}`);
    let result;
    try { result = await client.systemOne({ state, questions }); }
    catch { throw new Error("Jev request failed; no new verdicts or output were written. Check service connectivity and authentication."); }
    usage.requests += 1;
    if (!result || typeof result !== "object") continue;
    usage.input += Number.isFinite(result.usage?.input_tokens) && result.usage.input_tokens >= 0 ? result.usage.input_tokens : 0;
    usage.output += Number.isFinite(result.usage?.output_tokens) && result.usage.output_tokens >= 0 ? result.usage.output_tokens : 0;
    for (const record of batch) {
      const retention = result.answers?.[`r_e${record.index}`];
      if (!validRetention(retention)) continue;
      record.retention = { score: retention.score, confidence: retention.confidence };
      const intent = result.answers?.[`c_e${record.index}`]?.choice;
      record.intent = Object.hasOwn(CATEGORIES, intent) ? intent : null;
    }
  }
}

// Thresholds are applied fresh every run, so retuning them costs nothing.
// Asymmetric on purpose: a drop needs both a low score and real confidence, so
// uncertainty keeps.
//
function applyRetention(candidates, options) {
  for (const record of candidates) {
    if (record.removed || record.protected || record.text?.length > options.chars) continue;
    const verdict = record.retention;
    if (!validRetention(verdict) || verdict.score >= options.threshold) continue;
    if (verdict.confidence >= options.minConfidence) {
      record.removed = `noise ${verdict.score.toFixed(2)}/${verdict.confidence.toFixed(2)}`;
    }
  }
}

// ---- steering text ----------------------------------------------------------

const NOISE_NAME = {
  [CATEGORY.TOOL_OUTPUT]: "tool results",
  [CATEGORY.STATUS_OUTPUT]: "test and build logs",
  [CATEGORY.FILE_READ]: "file reads",
  [CATEGORY.TOOL_CALL]: "tool calls",
  [CATEGORY.MEDIA]: "images",
  [CATEGORY.THINKING]: "reasoning blocks",
  [CATEGORY.HUMAN_NUDGE]: "bare nudges",
  [CATEGORY.INJECTED]: "injected reminders",
  [CATEGORY.LOCAL_ONLY]: "local-only records",
  [CATEGORY.EMPTY]: "empty entries",
  [CATEGORY.PROSE]: "assistant asides",
};

const LABEL = {
  [CATEGORY.HUMAN_INSTRUCTION]: "asked",
  [CATEGORY.PROSE]: "said",
};

// An entry labelled `narration` that still survived did so on its retention score, not
// its intent. Printing the label would tell the summariser the opposite.
const INTENT_LABELS = new Set(["decision", "diagnosis", "plan", "contract", "result"]);

// File-mutating tool names identify attempted changes; calls do not prove success.
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Harness scratch: tool-result spill files, session state, temp dirs. Real paths only.
const NOT_A_SOURCE_FILE = /(^|\/)(tool-results|\.claude|node_modules|\.git)\/|^\/tmp\/|scratchpad\//;

// A real file, not a bare directory or a glob: the last segment carries an extension.
const IS_FILE_PATH = (path) => /[^/*]+\.[A-Za-z0-9]+$/.test(path);

// Preserve full file targets in a bounded reading aid alongside tool excerpts.
function touchedFiles(records) {
  const edited = new Set(), read = new Set();
  for (const record of records) {
    const blocks = record.entry?.message?.content;
    if (Array.isArray(blocks)) for (const block of blocks) {
      const path = block?.input?.file_path ?? block?.input?.path;
      if (block?.type === "tool_use" && WRITE_TOOLS.has(block.name) && typeof path === "string" &&
          IS_FILE_PATH(path) && !NOT_A_SOURCE_FILE.test(path)) edited.add(path);
    }
    if (record.category === CATEGORY.FILE_READ) for (const path of record.paths ?? []) {
      if (IS_FILE_PATH(path) && !NOT_A_SOURCE_FILE.test(path)) read.add(path);
    }
  }
  for (const path of edited) read.delete(path);
  return { edited: [...edited], read: [...read] };
}

function fileList(paths, limit) {
  if (paths.length <= limit) return paths.join(", ");
  return `${paths.slice(0, limit).join(", ")}, and ${paths.length - limit} more`;
}

// The first 280 characters of a file dump is its import block, and the first 280 of a
// long explanation is half a sentence. Cut on a sentence boundary when there is one.
function excerpt(text, limit) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return stop > limit * 0.4 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

const bytes = (text) => Buffer.byteLength(text, "utf8");

// Bound steering in UTF-8 bytes. Excerpts are a reading aid, never a replacement
// for the summarizer inspecting the original conversation and tool evidence.
function truncateBytes(text, limit) {
  let result = "";
  for (const character of text) {
    const size = bytes(character);
    if (size > limit) break;
    result += character;
    limit -= size;
  }
  return result;
}

function precompactInstructions(allRecords) {
  const records = allRecords.filter((r) => r.category !== CATEGORY.LOCAL_ONLY);
  if (!records.length) return "";
  const summary = records.findLast((r) => r.category === CATEGORY.COMPACT_SUMMARY);
  let output = "Compaction aid based on transcript records, not a measurement of the live context. " +
    "Removal flags are heuristic suggestions, not proof that content has no value. " +
    "Preserve all user constraints, decisions and reasons, exact identifiers and measurements, " +
    "unresolved failures, pending tool calls, and tool evidence needed to understand results. " +
    "Later user instructions and explicit corrections take precedence over older statements and summaries. " +
    "The excerpts below are incomplete; consult the conversation for full details.\n";
  if (summary) output += `Use the latest compaction summary at entry ${summary.index} as prior-history context, preserving its durable substance except where later instructions or evidence correct it.\n`;
  const files = touchedFiles(records);
  if (files.edited.length) output += `Files addressed by edit calls (success not inferred): ${truncateBytes(fileList(files.edited, 12), 700)}\n`;
  if (files.read.length) output += `Files read: ${truncateBytes(fileList(files.read, 12), 500)}\n`;
  const eligible = records.filter((r) => !r.removed && r.text?.length && r.category !== CATEGORY.COMPACT_SUMMARY);
  eligible.sort((a, b) => Number(b.category === CATEGORY.HUMAN_INSTRUCTION) - Number(a.category === CATEGORY.HUMAN_INSTRUCTION) ||
    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.retention?.score ?? 1) - (a.retention?.score ?? 1) || b.index - a.index);
  for (const record of eligible) {
    const label = INTENT_LABELS.has(record.intent) ? record.intent : LABEL[record.category] ?? record.category;
    const line = `- e${record.index} (${label}) ${truncateBytes(excerpt(record.text, 280), 900)}\n`;
    if (bytes(output) + bytes(line) <= PRECOMPACT_BUDGET) output += line;
  }
  return truncateBytes(output, PRECOMPACT_BUDGET);
}

// ---- reporting --------------------------------------------------------------

// A text-only sizing heuristic. This excludes tool schemas, signatures, images and
// other runtime context, and is not a tokenizer or a live-context measurement.
const approxTokens = (chars) => Math.round(chars / 4);
const megabytes = (n) => `${(n / 1e6).toFixed(1)} MB`;

function tallyOf(records) {
  const tally = {};
  for (const record of records) {
    const reason = record.removed.split(" ")[0];
    tally[reason] = (tally[reason] ?? 0) + 1;
  }
  return Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([r, c]) => `${c} ${r}`).join(", ") || "none";
}

// Cheapest possible live call: proves the key and the network path, nothing more.
async function selfTest(options) {
  const sdk = await loadSdk();
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set.");
  const client = new sdk.TypeSafeClient(options.model ? { defaultModel: options.model } : {});
  let result;
  try { result = await client.systemOne({
    state: { probe: "a build log line reading: process finished with exit code 0" },
    questions: { transient: sdk.noul("Is `probe` a transient status line with no lasting content?") },
  }); } catch { throw new Error("Jev self-test failed. Check service connectivity and authentication."); }
  process.stdout.write(`ok — noul ${result.answers.transient.noul.toFixed(2)}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) return selfTest(options);

  const { records, start, totalEntries, totalTurns } = loadRecords(options.input, { fullLog: options.fullLog, format: options.format });
  const state = loadState(options.state);

  const totalChars = records.reduce((sum, record) => sum + (record.text?.length ?? 0), 0);
  const totalImages = records.reduce((sum, record) => sum + (record.imageBytes ?? 0), 0);

  protectRecords(records, options.keepTail);
  dedupPayloads(records);
  runPolicies(records, options.keepTail);

  // Replay only verdicts whose full content and judging configuration still match.
  let reused = 0;
  for (const record of records) {
    // Only prose is ever judged, so only prose replays. A state file written by an
    // older version holds verdicts for tool output too; those are simply not read.
    if (!POLICY[record.category]?.judge) continue;
    const cached = state.verdicts[verdictKey(record, options)];
    if (!validRetention(cached?.retention) || record.text?.length > options.chars || record.protected) continue;
    record.retention = cached.retention;
    // Older state files stored the intent as the target key (`prose:narration`).
    if (cached.intent) record.intent = cached.intent;
    else if (typeof cached.key === "string" && cached.key.startsWith("prose:")) record.intent = cached.key.slice(6);
    reused += 1;
  }

  const candidates = records.filter((record) =>
    !record.removed && !record.protected && POLICY[record.category]?.judge && record.text?.length && record.text.length <= options.chars);
  const unscored = candidates.filter((record) => !record.retention);

  const recoveryRanking = options.recoveryRank ? prepareRecoveryRanking(records, options, state.recoveryRank) : null;
  if (options.plan) {
    const byCategory = new Map();
    for (const record of records) byCategory.set(record.category, (byCategory.get(record.category) ?? 0) + 1);
    const breakdown = [...byCategory.entries()].sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `                 ${String(count).padStart(6)} ${category}`).join("\n");
    process.stdout.write(
      `entries on disk  ${totalEntries}\n` +
      `analyzed window  ${records.length} from entry ${start}` +
      `${options.fullLog ? " (--full-log: whole file)" : start ? " (verified boundary evidence)" : " (whole log; no unambiguous boundary)"}\n` +
      `${breakdown}\n` +
      `removed by rule  ${records.filter((r) => r.removed).length} (${tallyOf(records.filter((r) => r.removed))})\n` +
      `cached verdicts  ${reused} reused from ${options.state ?? "(no state file)"}\n` +
      `jev candidates   ${unscored.length} prose entries, batch limit ${options.batch} (UTF-8 request limits may split or skip entries)\n` +
      `text heuristic   ~${approxTokens(totalChars).toLocaleString()} tokens (chars/4; not live context)` +
      `${totalImages ? ` + ${megabytes(totalImages * 0.75)} image payload` : ""}\n` +
      `jev payload      ~${unscored.reduce((s, r) => s + Math.min(r.text.length, options.chars), 0).toLocaleString()} chars\n` +
      (recoveryRanking ?
        `recovery rank    opt-in: ${recoveryRanking.candidates.length} passages (${recoveryRanking.candidates.filter(item => item.verdict).length} cached, ${recoveryRanking.candidates.filter(item => !item.verdict).length} unscored), ${recoveryRanking.pairs.length} pairs (${recoveryRanking.pairs.filter(item => item.verdict).length} cached, ${recoveryRanking.pairs.filter(item => !item.verdict).length} unscored)\n` +
        `expanded egress  <=${[...recoveryRanking.candidates.filter(item => !item.verdict).map(item => [item]), ...recoveryRanking.pairs.filter(item => !item.verdict).map(item => [item.older,item.newer])].reduce((bytes,items) => bytes + Buffer.byteLength(recoveryRanking.query) + items.reduce((sum,item) => sum + Buffer.byteLength(item.text + item.lead + (item.scope?.name ?? '') + (item.scope?.command ?? '') + (item.scope?.cwd ?? '')),0),0)} source/query/scope UTF-8 bytes before JSON/questions; <=30000 serialized bytes/request; plan sends nothing\n` : ''),
    );
    return;
  }

  const usage = { input: 0, output: 0, requests: 0 };

  if (!options.offline && unscored.length) {
    const sdk = await loadSdk();
    if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set.");
    const client = new sdk.TypeSafeClient(options.model ? { defaultModel: options.model } : {});
    await runPass1(client, sdk, unscored, options, usage);
  }
  if (recoveryRanking && options.update && !options.offline &&
      (recoveryRanking.candidates.some(item => !item.verdict) || recoveryRanking.pairs.some(item => !item.verdict))) {
    const sdk = await loadSdk();
    if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set.");
    const client = new sdk.TypeSafeClient(options.model ? { defaultModel: options.model } : {});
    state.recoveryRank = await scoreRecoveryRanking(client, sdk, recoveryRanking, usage, state.recoveryRank);
  }
  if (recoveryRanking) process.stderr.write(`recovery ranking: ${recoveryRanking.candidates.length} bounded passages, ${recoveryRanking.pairs.length} pairs, ${recoveryRanking.candidates.filter(item => item.verdict).length} passage verdicts available\n`);
  applyRetention(candidates, options);
  process.stderr.write("\r\x1b[K");

  if (options.state && !options.offline) {
    for (const record of records) {
      if (!validRetention(record.retention)) continue;
      state.verdicts[verdictKey(record, options)] = {
        index: record.index,
        category: record.category,
        retention: record.retention,
        ...(record.intent && { intent: record.intent }),
      };
    }
    state.anchor = records[0]?.id ?? null;
    state.scanned = records.length;
    state.updated = new Date().toISOString();
    saveState(options.state, state, usage);
  }

  const kept = records.filter((record) => !record.removed);
  const removed = records.filter((record) => record.removed);
  const keptChars = kept.reduce((sum, record) => sum + (record.text?.length ?? 0), 0);

  if (options.recovery) {
    process.stdout.write(recoveryEvidence(records.filter(record => !record.recoveryExcluded), 6000, recoveryRanking ? rankedPassages(recoveryRanking) : null));
    return;
  }
  if (options.precompact) {
    process.stdout.write(precompactInstructions(records));
    return;
  }
  if (options.update) {
    process.stderr.write(
      `trashcompact: ${records.length} analyzed of ${totalEntries} entries, ` +
      `+${unscored.filter((r) => validRetention(r.retention)).length} scored, ${reused} cached, ${usage.requests} requests, ` +
      `${usage.input} billed input tokens reported\n`,
    );
    return;
  }

  const body = options.digest
    ? kept.filter((record) => record.text?.length).map((record) => `## ${record.category} (e${record.index})\n\n${record.text}`).join("\n\n")
    : kept.map((record) => record.raw).join("\n");

  if (options.out) writeFileSync(options.out, `${body}\n`);
  else process.stdout.write(`${body}\n`);

  process.stderr.write(
    `\nwindow   ${totalEntries} on disk → ${records.length} analyzed (from entry ${start}), ${totalTurns} turn${totalTurns === 1 ? "" : "s"}\n` +
    `entries  ${records.length} → ${kept.length}  (removed ${removed.length}: ${tallyOf(removed)})\n` +
    `text heuristic  ~${approxTokens(totalChars).toLocaleString()} → ~${approxTokens(keptChars).toLocaleString()} tokens (chars/4; not live context)  ` +
    `(${(100 - (keptChars / Math.max(totalChars, 1)) * 100).toFixed(1)}% smaller)` +
    `${totalImages ? ` + ${megabytes(totalImages * 0.75)} image payload` : ""}\n` +
    `jev      ${usage.requests} requests, ${usage.input.toLocaleString()} input tokens, ${candidates.length} prose entries eligible\n` +
    `${options.out ? `written  ${options.out}\n` : ""}`,
  );
}

export { parseArguments, loadRecords, dedupPayloads, protectRecords, runPolicies, runPass1, applyRetention,
  precompactInstructions, loadState, saveState, verdictKey, validRetention };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  process.stderr.write(`trashcompact: ${error.message}\n`);
  process.exitCode = 1;
});
