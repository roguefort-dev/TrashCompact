#!/usr/bin/env node
import { setDailyChecks, updateStatus, checkForUpdates, describeUpdate } from "../src/updates.mjs";

try {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || !["enable", "disable", "status", "check"].includes(command)) {
    process.stderr.write("Usage: node bin/updates.mjs enable|disable|status|check\n");
    process.exitCode = 1;
  } else if (command === "enable" || command === "disable") {
    setDailyChecks(command === "enable");
    process.stdout.write(`Daily repository checks ${command === "enable" ? "enabled" : "disabled"}. No software is installed or updated.\n`);
  } else if (command === "check") {
    const result = await checkForUpdates();
    process.stdout.write(`${describeUpdate(result)}\n`);
    if (result.status === "unavailable") process.exitCode = 1;
  } else {
    const { enabled, result } = updateStatus();
    process.stdout.write(`Daily repository checks ${enabled ? "enabled" : "disabled"}.\n${describeUpdate(result)}${result ? ` Checked ${result.checkedAt}.` : ""}\n`);
  }
} catch {
  process.stderr.write("trashcompact: could not access repository-check settings or results.\n");
  process.exitCode = 1;
}
