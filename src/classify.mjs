// Category-first classification. Pure code, no model, no network.
//
// Every entry gets a category before anything is scored. Categories carry a policy,
// and only explicitly local or empty records are removable by static policy.
// Only standalone assistant PROSE reaches Jev; mixed records remain protected.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Categories are ordered roughly by how much of a window they occupy.
export const CATEGORY = {
  TOOL_OUTPUT: "tool_output",     // a result with no cheaper classification
  STATUS_OUTPUT: "status_output", // test / build / lint / git evidence
  FILE_READ: "file_read",         // file contents, including partial reads
  TOOL_CALL: "tool_call",         // the request the model issued
  MEDIA: "media",                 // image payload
  PROSE: "prose",                 // assistant text — the only paid judgement
  THINKING: "thinking",           // reasoning blocks
  HUMAN_INSTRUCTION: "human_instruction",
  HUMAN_NUDGE: "human_nudge",     // legacy category, retained conservatively
  INJECTED: "injected",           // legacy category, retained conservatively
  COMPACT_SUMMARY: "compact_summary", // the carried-forward history; never discardable
  LOCAL_ONLY: "local_only",       // never sent to the API; cannot affect a summary
  EMPTY: "empty",
};

// Position and repeated targets are not evidence that context has become obsolete.
// Only known local metadata and genuinely empty messages can be removed by policy.
export const POLICY = Object.fromEntries(Object.values(CATEGORY).map((category) => [category, {
  halfLife: [CATEGORY.LOCAL_ONLY, CATEGORY.EMPTY].includes(category) ? 0 : null,
  eligible: ![CATEGORY.LOCAL_ONLY, CATEGORY.EMPTY].includes(category),
  supersede: null,
  ...(category === CATEGORY.PROSE ? { judge: true } : {}),
  ...(category === CATEGORY.COMPACT_SUMMARY ? { pinned: true } : {}),
}]));

// Commands whose output describes status; failures may remain unresolved indefinitely.
const STATUS_COMMAND = /\b(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?(?:test|build|lint|typecheck|jest|vitest|tsc)\b|\b(?:vitest|jest|pytest|eslint|prettier|ruff|black|tsc|mypy)\b|^\s*git\s+(?:status|diff|log|add|commit|push|pull|fetch|stash)\b|^\s*(?:echo|true|false|sleep|clear)\b|\bmake\b/;

// Commands that emit file-related evidence, including partial reads.
const READER_COMMAND = /\b(?:cat|sed|head|tail|grep|rg|wc|awk|nl|less|more|jq|od|xxd)\b/;

// Tools that read rather than act.
const READER_TOOL = new Set(["Read", "NotebookRead", "Glob", "Grep"]);

// Steering contains readable evidence from every block; the original entry remains
// untouched, including binary payloads and signatures.
function blockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return JSON.stringify(block) ?? "";
  if (block.type === "text") return typeof block.text === "string" ? block.text : JSON.stringify(block);
  if (block.type === "thinking") return block.thinking || "[thinking signature]";
  if (block.type === "image") return "[image]";
  if (block.type === "tool_use") return `[${block.name} ${block.id}] ${JSON.stringify(block.input ?? {})}`;
  if (block.type === "tool_result") {
    const inner = Array.isArray(block.content) ? block.content.map(blockText).join("\n")
      : typeof block.content === "string" ? block.content : JSON.stringify(block.content) ?? "";
    return `[tool_result ${block.tool_use_id}${block.is_error ? " error" : ""}] ${inner}`;
  }
  return JSON.stringify(block);
}

/** Keep complete path tokens: suffixes can collide across different roots. */
export function pathsInCommand(command) {
  return [...String(command ?? "").matchAll(/(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;|&<>]+))/g)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((token) => !token.startsWith("-") && (token.includes("/") || /\.[a-zA-Z0-9]+$/.test(token)));
}

/** Content alone cannot establish who authored an injected-looking message. */
export function isInjected() { return false; }

/** A summary flag is not a boundary: partial compaction can retain earlier turns. */
export function liveWindowStart() { return 0; }

/** Short replies can grant consent, refuse, or stop work; always retain them. */
export function isNudge() { return false; }

/** Preserve literals, identifiers, quotations and user intent byte-for-byte. */
export function redact(text) { return text; }

/** Total base64 image bytes anywhere inside a value. */
export function imageBytes(value) {
  let total = 0;
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== "object") return;
    if (node.type === "image" && node.source?.data) total += node.source.data.length;
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(value);
  return total;
}

/**
 * Classify one entry.
 *
 * @param entry        parsed transcript record
 * @param toolByUseId  Map of tool_use id -> { name, input }, built over the whole file
 * @returns { category, text, paths, supersedeKey, imageBytes }
 */
export function classify(entry, toolByUseId = new Map()) {
  const base = { category: CATEGORY.EMPTY, text: "", paths: [], supersedeKey: null, imageBytes: 0 };
  const content = entry.message?.content;
  const blocks = Array.isArray(content) ? content : content == null ? [] : [content];
  const text = blocks.map(blockText).join("\n");
  const images = imageBytes(content);
  const record = { ...base, text, imageBytes: images };
  // Summary protection is independent of role and content representation.
  if (entry.isCompactSummary) return { ...record, category: CATEGORY.COMPACT_SUMMARY, pinned: true };
  if (entry.type !== "assistant" && entry.type !== "user") {
    const localTypes = new Set(["file-history-snapshot", "progress", "queue-operation"]);
    if (localTypes.has(entry.type) && !entry.message) return { ...base, category: CATEGORY.LOCAL_ONLY };
    return { ...record, category: CATEGORY.TOOL_OUTPUT, text: text || JSON.stringify(entry), pinned: true };
  }
  if (content == null) return { ...record, category: CATEGORY.TOOL_OUTPUT, text: JSON.stringify(entry), pinned: true };
  if (!blocks.length || blocks.every((block) => typeof block === "string" ? !block.trim()
      : block?.type === "text" && typeof block.text === "string" && !block.text.trim())) return base;

  const results = blocks.filter((block) => block?.type === "tool_result");
  const calls = blocks.filter((block) => block?.type === "tool_use");
  const hasHumanText = blocks.some((block) => typeof block === "string" || block?.type === "text");
  const pureText = blocks.every((block) => typeof block === "string" || (block?.type === "text" && typeof block.text === "string"));
  if (entry.type === "user" && (hasHumanText || (!results.length && !calls.length))) {
    return { ...record, category: CATEGORY.HUMAN_INSTRUCTION, pinned: !pureText };
  }
  if (calls.length || results.length) {
    const paths = [];
    const resultCategories = [];
    for (const result of results) {
      const tool = toolByUseId.get(result.tool_use_id);
      const input = tool?.input ?? {};
      const command = String(input.command ?? "");
      let category = CATEGORY.TOOL_OUTPUT;
      if (tool?.name === "Bash") {
        if (STATUS_COMMAND.test(command)) category = CATEGORY.STATUS_OUTPUT;
        else if (READER_COMMAND.test(command)) { category = CATEGORY.FILE_READ; paths.push(...pathsInCommand(command)); }
      } else if (READER_TOOL.has(tool?.name)) {
        category = CATEGORY.FILE_READ;
        if (input.file_path ?? input.path) paths.push(String(input.file_path ?? input.path));
      }
      resultCategories.push(category);
    }
    for (const call of calls) {
      const input = call.input ?? {};
      if (input.file_path ?? input.path) paths.push(String(input.file_path ?? input.path));
      if (input.command) paths.push(...pathsInCommand(input.command));
    }
    const category = calls.length ? CATEGORY.TOOL_CALL
      : resultCategories.every((category) => category === resultCategories[0]) ? resultCategories[0] : CATEGORY.TOOL_OUTPUT;
    // Call IDs describe identity only, never supersession by target or age.
    const only = blocks.length === 1 ? blocks[0] : null;
    const id = only?.id ?? only?.tool_use_id;
    return { ...record, category, paths: [...new Set(paths)], supersedeKey: id ? `call:${id}` : null,
      pinned: blocks.length > 1 || images > 0 };
  }
  if (pureText) return { ...record, category: CATEGORY.PROSE };
  if (blocks.every((block) => block?.type === "thinking" || block?.type === "redacted_thinking"))
    return { ...record, category: CATEGORY.THINKING, pinned: true };
  if (blocks.every((block) => block?.type === "image")) return { ...record, category: CATEGORY.MEDIA, pinned: true };
  return { ...record, category: CATEGORY.TOOL_OUTPUT, pinned: true };
}

/** Drop only explicitly local metadata and empty content, outside the protected tail. */
export function applyPolicies(classified, { keepTail = 0, total = classified.length } = {}) {
  const drop = new Map();
  classified.forEach((item, index) => {
    if (index >= total - keepTail || item.pinned || item.protected) return;
    if (item.category === CATEGORY.LOCAL_ONLY || item.category === CATEGORY.EMPTY) drop.set(index, item.category);
  });
  return drop;
}

/** Content hash that ignores the envelope, so duplicate payloads collapse. */
const ENVELOPE = new Set([
  "uuid", "parentUuid", "timestamp", "sessionId", "requestId", "version", "gitBranch",
  "cwd", "userType", "isSidechain", "isMeta", "logicalParentUuid", "isCompactSummary",
]);

export function contentHash(entry) {
  const strip = (node) => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === "object") {
      const out = {};
      for (const key of Object.keys(node).sort()) if (!ENVELOPE.has(key)) out[key] = strip(node[key]);
      return out;
    }
    return node;
  };
  return createHash("sha1").update(JSON.stringify(strip(entry))).digest("hex");
}

// Compatibility smoke test; detailed adversarial cases live in test/classify.test.mjs.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--self-test")) {
  const item = classify({ type: "user", message: { content: "no" } });
  if (item.category !== CATEGORY.HUMAN_INSTRUCTION || applyPolicies([item]).size) throw new Error("human instruction lost");
  process.stdout.write("classify self-test: all checks passed\n");
}
