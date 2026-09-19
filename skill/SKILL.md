---
name: trashcompact
description: Install TrashCompact for your harness, inspect explicit transcripts, and preserve bounded evidence across native compaction. Check docs/SETUP.md for supported integrations.
---

# TrashCompact

First install the [TypeSafe agent skill](https://docs.typesafe.ai/agent-skill#installation) globally for the selected application, reusing an existing installation, and read its instructions. Then read `docs/SETUP.md` in the TrashCompact checkout and follow its target-specific instructions. Use `node install.mjs --target codex|claude|opencode|opencode2 --non-interactive` with the confirmed target. Give the human an absolute `node /path/to/install/key.mjs` command for private terminal entry; never request, read, or handle the API key in chat. Complete any required human trust review for the selected integration. Restart/reopen the application after setup. Preserve existing settings and dirty checkouts.

Follow the one-time update-check opt-in in `docs/SETUP.md` during installation. Preserve a saved choice on reinstall; do not ask during ordinary skill use.

Use the repository CLI to inspect an explicitly selected transcript in a supported format, score eligible assistant prose, or create an offline recovery note. Locate the installed TrashCompact checkout before running its commands; do not assume the user's current project contains the executable.

```bash
node bin/launch.mjs <rollout.jsonl> --format codex --plan
node bin/launch.mjs <rollout.jsonl> --format codex --update
node bin/launch.mjs <rollout.jsonl> --format codex --recovery
```

`--plan` and `--recovery` are offline. Online scoring sends eligible transcript text to TypeSafe; use the user's existing authorization for that transcript.

Use the rollout path from the active task or hook. Never guess by choosing the newest file across sessions/subagents. Treat the format as version-sensitive. Preserve raw records and tool-call identities; the standalone CLI default admits only standalone visible assistant prose; the compaction hook additionally enables bounded passage ranking. User instructions, engine instructions, mixed/unknown content and opaque reasoning are not prose candidates.

Jev-based removal requires both a low retention score on the 0–2 scale and sufficient confidence on the 0–1 scale. Static rules run before scoring. They remove known local metadata, empty records, adjacent exact assistant repetitions, and recognized complete no-op or duplicate read-only tool exchanges. Recognized failed exchanges stay through the result's turn and the next human turn, then expire when two later human turns have begun. Recognized Node test output keeps aggregate final results and failed-test diagnostics while removing individual passing-test lines. Preserve incomplete, truncated, mixed, and unrecognized exchanges. See docs/CLI.md for the exact tool rules.

Jev does not remove unscored or oversized entries. The protected tail defaults to 5 records. Jev scoring and cached removal decisions leave that recent text intact. Deterministic rules still remove known local metadata, empty assistant messages, and exact adjacent assistant repetitions within the same human turn, keeping the latest copy. Recognized tool cleanup also applies. These changes affect filtered exports and recovery selection, leaving live context intact. Use identical flags for comparable evaluation and a fresh state path when measuring live model behavior rather than cache replay.

Recovery notes quote historical evidence, omit engine boilerplate/ciphertext/previous recovery notes, and stay within 6,000 UTF-8 bytes. They are incomplete. Do not claim note delivery proves downstream recall, or that filtered-file size measures live-context savings.

The compaction hook enables experimental passage ranking. For manual use, inspect `--plan --recovery-rank`, score with `--update --recovery-rank`, then render using `--recovery --recovery-rank`. This opt-in expands external processing to bounded visible assistant spans, a latest-user query, short source context, and plain-text tool outputs where the integration supports online tool-passage ranking. Do not infer that authorization for the default assistant-only scorer covers that expanded scope. Caps are 96 passages, 24 relation pairs, and 30,000 serialized bytes per request; the recovery note remains 6,000 bytes. Only cached ranking is used offline. Preserve current user constraints/final status; uncertain relations and generic successful tests do not establish resolution. Source-span ranking never authorizes deleting a whole record. Model confidence is not proof of correctness or native recall improvement.

The optional `--relevance` mode groups user messages into tasks and judges exact assistant passages against complete recent task groups. Bugfix and dependency checks can veto removal; missing or uncertain judgments keep the passage. Use it only for derived `--digest`, `--precompact`, or `--recovery` output after `--update --relevance`. Raw source JSONL remains intact. When both flags are present, `--relevance` takes precedence over `--recovery-rank`; it skips passage ranking and renders recovery from the filtered text in deterministic order. `TRASHCOMPACT_FLAGS="--relevance"` opts hooks into this additional scoring and derived recovery filtering. This mode sends bounded user-task context and neighboring assistant text to TypeSafe. Check authorization for that expanded context before enabling it. See [the CLI guide](../docs/CLI.md#task-relevance).

## Integration and compatibility

Installing and trusting the Codex or Claude hooks enables asynchronous Stop scoring after completed turns and a synchronous PreCompact scoring pass when compaction occurs. Stop runs `--update` to score newly eligible assistant prose and reuse cached judgments, with a 110-second budget inside a 120-second hook timeout. It updates the cache without replacing the last message or compacting live context.

Codex ignores plain PreCompact stdout. PreCompact first runs a synchronous `--update --recovery-rank` pre-pass with a 45-second budget, then snapshots evidence offline with a 10-second budget even if scoring fails. Codex PostCompact resets scores immediately and retains the snapshot. PostCompact cannot inject model context. SessionStart(source=compact) supplies that snapshot as JSON additionalContext before the next model request and resets scores if PostCompact was missed. Notes have no time expiry; transcript identity, configuration, and compaction-boundary checks prevent stale or duplicate delivery. The note does not feed the native summarizer. It supplements the built-in summary; it does not replace the compactor, edit the rollout, or remove live messages. Use Codex's `/hooks` interface for required trust review; never bypass it to make installation appear complete.

Codex and supported OpenCode integrations rank bounded tool passages online. Claude Code tool-result passages remain local recovery evidence and are not ranked online.

Claude Code uses its own Stop, PreCompact, and SessionStart hook contract. OpenCode plugins add Jev-selected evidence to native compaction context before summarization; check the installed version supports the selected API. OpenCode 2 beta `0.0.0-beta-19157` lacks the required hook and is unsupported even though it can load the plugin. Both OpenCode targets share one plugin and skill, so uninstalling either removes the shared integration. The optional OpenCode 2 response-compaction service is independent and must not be enabled implicitly during setup. Manual compaction can be observed on the next user message. Installation does not rewrite an already-open conversation.

Stop reuses judgments between turns; native compaction expires them for fresh scoring. See [cache behavior](../docs/CLI.md#retention-and-cache-behavior).
