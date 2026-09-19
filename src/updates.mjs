import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
export const UPDATE_HOME = join(homedir(), ".trashcompact", "updates");
export const UPSTREAM_URL = "https://api.github.com/repos/roguefort-dev/TrashCompact/commits/main";
const SHA = /^[a-f0-9]{40}$/;
const RESULTS = new Set(["matches", "differs", "unavailable"]);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

export function setDailyChecks(enabled, { home = UPDATE_HOME } = {}) {
  saveJson(join(home, "config.json"), { enabled: enabled === true });
}

export function updateStatus({ home = UPDATE_HOME } = {}) {
  const raw = readJson(join(home, "result.json"));
  const result = raw && RESULTS.has(raw.status) && typeof raw.checkedAt === "string" &&
    Number.isFinite(Date.parse(raw.checkedAt)) ? {
      status: raw.status,
      checkedAt: raw.checkedAt,
      ...(SHA.test(raw.local ?? "") && { local: raw.local }),
      ...(SHA.test(raw.upstream ?? "") && { upstream: raw.upstream }),
    } : null;
  return { enabled: readJson(join(home, "config.json"))?.enabled === true, result };
}

function localDay(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function localHead() {
  const { stdout } = await exec("git", ["-C", REPO, "rev-parse", "HEAD"], { timeout: 1500, maxBuffer: 1024 });
  return stdout.trim();
}

async function remoteHead(fetchImpl, signal) {
  const response = await fetchImpl(UPSTREAM_URL, {
    signal, redirect: "error", credentials: "omit",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "TrashCompact-update-check" },
  });
  if (!response.ok) throw new Error("HTTP failure");
  // Bound both response size and elapsed time; never persist upstream text.
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) throw new Error("Response too large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const sha = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.sha;
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Error("Invalid response");
  return sha;
}

export async function checkForUpdates({ home = UPDATE_HOME, now = () => new Date(),
  fetchImpl = globalThis.fetch, getLocalHead = localHead, timeoutMs = 3000 } = {}) {
  const checkedAt = now().toISOString();
  const controller = new AbortController();
  let timer;
  let result;
  try {
    const [local, upstream] = await Promise.race([
      Promise.all([getLocalHead(), remoteHead(fetchImpl, controller.signal)]),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Timeout")); }, timeoutMs);
      }),
    ]);
    if (typeof local !== "string" || !SHA.test(local)) throw new Error("Invalid checkout");
    result = { checkedAt, status: local === upstream ? "matches" : "differs", local, upstream };
  } catch {
    result = { checkedAt, status: "unavailable" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  saveJson(join(home, "result.json"), result);
  return result;
}

// Call only after a successful scoring/cache update. Claim before network work so
// simultaneous integrations, failures, and interrupted processes cannot retry today.
export async function maybeCheckForUpdates(options, dependencies = {}) {
  if (!options.update || options.offline || options.plan || options.recovery || options.precompact) return null;
  const { home = UPDATE_HOME, now = () => new Date() } = dependencies;
  try {
    if (!updateStatus({ home }).enabled) return null;
    const date = now();
    const claims = join(home, "days");
    mkdirSync(claims, { recursive: true, mode: 0o700 });
    closeSync(openSync(join(claims, localDay(date)), "wx", 0o600));
    return await checkForUpdates({ ...dependencies, now: () => date });
  } catch {
    // Update checks must never fail compaction or emit text into hook output.
    return null;
  }
}

export function describeUpdate(result) {
  if (!result) return "No repository check saved.";
  if (result.status === "matches") return "This checkout's commit matches official main.";
  if (result.status === "differs") return "This checkout's commit differs from official main. It may be ahead, behind, or diverged; review before updating.";
  return "Repository check unavailable. Try a manual check later.";
}
