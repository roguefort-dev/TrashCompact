import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDailyChecks, updateStatus, maybeCheckForUpdates, checkForUpdates, describeUpdate, UPSTREAM_URL } from "../src/updates.mjs";

const local = "a".repeat(40);
const upstream = "b".repeat(40);
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "trashcompact-updates-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let date = new Date(2026, 8, 19, 12);
  let requests = 0;
  return {
    home, get requests() { return requests; }, setDate(value) { date = value; },
    dependencies: {
      home, now: () => date, getLocalHead: async () => local,
      fetchImpl: async (url, options) => {
        requests++;
        assert.equal(url, UPSTREAM_URL);
        assert.equal(options.redirect, "error");
        assert.equal(options.credentials, "omit");
        return new Response(JSON.stringify({ sha: upstream, message: "untrusted text" }));
      },
    },
  };
}

test("daily checks default off and excluded modes do not claim a day", async t => {
  const f = fixture(t);
  assert.deepEqual(updateStatus({ home: f.home }), { enabled: false, result: null });
  assert.equal(await maybeCheckForUpdates({ update: true }, f.dependencies), null);
  assert.deepEqual(readdirSync(f.home), []);
  setDailyChecks(true, f.dependencies);
  for (const options of [{}, { update: true, offline: true }, { update: true, plan: true },
    { update: true, recovery: true }, { update: true, precompact: true }]) {
    assert.equal(await maybeCheckForUpdates(options, f.dependencies), null);
  }
  assert.equal(f.requests, 0);
  assert.deepEqual(readdirSync(f.home), ["config.json"]);
});

test("concurrent checks claim one local day across integrations and roll over tomorrow", async t => {
  const f = fixture(t);
  setDailyChecks(true, f.dependencies);
  const results = await Promise.all(Array.from({ length: 8 }, () => maybeCheckForUpdates({ update: true }, f.dependencies)));
  assert.equal(f.requests, 1);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(updateStatus(f.dependencies).result.status, "differs");
  assert.match(describeUpdate(results.find(Boolean)), /ahead, behind, or diverged/);
  assert.equal(readFileSync(join(f.home, "result.json"), "utf8").includes("untrusted"), false);
  assert.deepEqual(readdirSync(join(f.home, "days")), ["2026-09-19"]);
  f.setDate(new Date(2026, 8, 20, 0, 1));
  await maybeCheckForUpdates({ update: true }, f.dependencies);
  assert.equal(f.requests, 2);
  setDailyChecks(false, f.dependencies);
  f.setDate(new Date(2026, 8, 21, 0, 1));
  await maybeCheckForUpdates({ update: true }, f.dependencies);
  assert.equal(f.requests, 2);
});

test("failed daily check is recorded without retrying that day", async t => {
  const f = fixture(t);
  let attempts = 0;
  setDailyChecks(true, f.dependencies);
  const dependencies = { ...f.dependencies, fetchImpl: async () => { attempts++; throw new Error("secret upstream error"); } };
  assert.equal((await maybeCheckForUpdates({ update: true }, dependencies)).status, "unavailable");
  assert.equal(await maybeCheckForUpdates({ update: true }, dependencies), null);
  assert.equal(attempts, 1);
  assert.equal(readFileSync(join(f.home, "result.json"), "utf8").includes("secret"), false);
});

test("manual checks work while disabled and do not enable daily checks", async t => {
  const f = fixture(t);
  const result = await checkForUpdates({ ...f.dependencies, getLocalHead: async () => upstream });
  assert.equal(result.status, "matches");
  assert.equal(updateStatus(f.dependencies).enabled, false);
  await checkForUpdates(f.dependencies);
  assert.equal(f.requests, 2);
  assert.deepEqual(readdirSync(f.home), ["result.json"]);
});

test("HTTP errors, malformed or oversized responses, bad local HEAD and timeouts are unavailable", async t => {
  const f = fixture(t);
  for (const fetchImpl of [
    async () => new Response("rate limited", { status: 403 }),
    async () => new Response("not json"),
    async () => new Response(JSON.stringify({ sha: "bad" })),
    async () => new Response("x".repeat(262145)),
    async () => new Promise(() => {}),
  ]) {
    assert.equal((await checkForUpdates({ ...f.dependencies, fetchImpl, timeoutMs: 20 })).status, "unavailable");
  }
  assert.equal((await checkForUpdates({ ...f.dependencies, getLocalHead: async () => "invalid" })).status, "unavailable");
});

test("settings storage errors cannot fail an incremental update", async t => {
  const f = fixture(t);
  setDailyChecks(true, f.dependencies);
  assert.equal(await maybeCheckForUpdates({ update: true }, { ...f.dependencies, home: join(f.home, "config.json") }), null);
});
