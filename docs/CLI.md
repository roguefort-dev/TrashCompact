# CLI guide

Complete [setup](SETUP.md), including the global TypeSafe agent skill, before using these commands. Run them from the checkout. The example transcript is synthetic.

```sh
# Inspect without an API request.
node bin/launch.mjs example/codex-review.jsonl --format codex --plan

# Score eligible text through TypeSafe and cache the results.
node bin/launch.mjs example/codex-review.jsonl --format codex --update --keep-tail 0

# Write a digest using static rules and cached scores.
node bin/launch.mjs example/codex-review.jsonl --format codex --offline --keep-tail 0 --digest --out digest.md

# Print a recovery note using the same cache.
node bin/launch.mjs example/codex-review.jsonl --format codex --recovery --keep-tail 0
```

`--plan`, `--offline`, and `--recovery` make no API requests. Offline modes keep unscored assistant text unless static rules remove it. `--keep-tail 0` lets this short fixture qualify for scoring.

For real work, use the transcript path supplied by your harness or active task. Do not pick the newest file, which may belong to another task. Commands leave the source transcript and live history untouched.

## Repository update checks

Daily repository checks are off by default. Opt in with an explicit command:

```sh
node bin/updates.mjs enable
node bin/updates.mjs status
node bin/updates.mjs check
node bin/updates.mjs disable
```

Once enabled, the first successful online `--update` each local calendar day checks official `roguefort-dev/TrashCompact` main on GitHub. Codex, Claude, and OpenCode share the daily limit for the same OS user. Offline, plan, and standalone recovery commands do not check. Failed checks consume that day's attempt. `check` requests a check immediately, even when daily checks are disabled, without enabling them.

Checks compare this checkout's HEAD with upstream main. A difference can mean ahead, behind, or diverged; it does not establish that an update is available. Checks never fetch Git objects, pull, install, or change the checkout. Uncommitted changes are not compared. The request has a three-second timeout and sends no transcripts or TypeSafe credentials.

Settings, daily attempt markers, and the latest result stay in `~/.trashcompact/updates`, outside transcript caches. Hooks emit no update notice; `status` shows whether checks are enabled and the saved result with its timestamp. A failed check does not fail compaction. The existing `--update` flag still refreshes verdict caches.

## Common flags

| Flag | Default | Effect |
|---|---|---|
| `--format` | `auto` | Detect Codex or Claude input. Use an explicit format in hooks. |
| `--keep-tail N` | `5` | Protect the last N records from Jev scoring while checking for known noise. |
| `--threshold N` | `0.75` | Drop scores below N on the 0–2 scale, if confidence is sufficient. |
| `--min-confidence N` | `0.55` | Minimum confidence for removal, on the 0–1 scale. |
| `--batch N` | `8` | Maximum entries per scoring request. |
| `--chars N` | `1200` | Keep longer entries intact without whole-entry scoring. |
| `--model ID` | `jev-1.13.0` | Choose a model. `TYPESAFE_DEFAULT_MODEL` can override the default. |
| `--state PATH` | Per-transcript cache | Choose another cache file. |

## Retention and cache behavior

Deterministic rules run before Jev. They check all records, including the last 5, for known local metadata, empty assistant messages, and exact adjacent assistant-text repetitions within a turn. The latest identical copy stays. Recent unique text remains protected from Jev scoring and cached removal decisions. Tool cleanup also applies:

- Remove complete successful no-op exchanges with empty output.
- Keep only the later identical read-only exchange in the same user turn, for supported literal `cat` and Claude `Read`, `Glob`, and `Grep` calls.
- Keep recognized failed exchanges until two later user turns have begun.
- Remove individual passing-test lines from complete, recognized Node TAP or spec reports. Keep final totals, failures, and unrecognized lines.

Unknown, mixed, incomplete, or truncated exchanges stay. User messages and summaries remain protected. Jev removes eligible assistant text only when both the score and confidence permit it.

Online scoring always saves a persistent cache, including input piped through stdin. File inputs use a cache keyed by their canonical path; stdin uses a hash of the complete input. Both default to `$CODEX_HOME/trashcompact` or `~/.codex/trashcompact`. Use `--state PATH` to reuse one cache across a growing stdin stream. `--update -` is supported. Each completed request is saved before the next request starts, so a later error or timeout preserves earlier judgments. A cache write failure stops scoring. Offline and plan modes never write scores.

Stop reuses scores until native compaction. When Codex dispatches `PostCompact`, the hook clears prose and recovery judgments. `SessionStart(source: "compact")` delivers the prepared note once before the next model request, and resets scores if PostCompact was missed. Claude resets and delivers through SessionStart. PostCompact does not support context injection. Prepared notes survive delays and are bound to the transcript identity, configuration, and completed boundary; a later compaction invalidates them. Native transcript markers also expire caches after a missed hook. The next scoring pass rebuilds judgments; offline reads ignore mismatched caches without writing. Generation checks reject stale in-flight writes. There is no time-based expiry. Legacy unbound caches rebuild once. None of this trims the original archive or identifies its exact live context.

OpenCode keeps scores for one native compaction callback, through scoring and recovery rendering, then removes the temporary cache. Its integration has no completion callback for a persistent cache reset.

Caches store judgments and hashes, not transcript text. They reuse judgments when the text and scoring settings match, while changed recovery queries or context may need new scores.

## Task relevance

Add `--relevance` to opt into task grouping and exact-passage relevance judgments. Use `--plan --relevance` to inspect the planned work without a request, `--update --relevance` to score and checkpoint it, then `--offline --digest --relevance` or `--recovery --relevance` to render the derived text. `--precompact` also supports this option. Raw JSONL output rejects it, and source records remain unchanged. Derived views label passage omissions.

The model groups user messages into tasks, including continuation messages and corrections. Relevance checks use complete recent task groups, with bounded source and neighboring context. A separate check decides whether unclear boundaries need older task context; uncertainty keeps it. An incomplete or oversized benchmark prevents removal. Separate bugfix and dependency checks can veto removal. Missing, invalid, or uncertain judgments keep the passage. These checks reduce accidental omission but do not prove that omitted material is useless.

Only online `--update` sends these requests to TypeSafe. Grouping and relevance expand the sent context beyond the default assistant prose scorer. Set `TRASHCOMPACT_FLAGS="--relevance"` in the hook environment to opt in for Stop scoring and compaction recovery. Existing flags can be included in the same value. The default hook configuration does not enable relevance removal. When combined with `--recovery-rank`, `--relevance` takes precedence: ranking requests are skipped and recovery uses the filtered text in deterministic order. Native compaction expires grouping and relevance judgments along with the other scores.

## Experimental recovery ranking

Add `--recovery-rank` to enable passage ranking. It is off for standalone commands and enabled by installed compaction hooks. Only `--update` sends ranking requests.

Ranking sends bounded visible assistant passages, the latest-user query, and source context to TypeSafe. Codex and supported OpenCode integrations also send bounded tool passages. Claude tool results remain local recovery evidence.

Ranking changes the selection of excerpts for a recovery note of at most 6,000 bytes. It does not delete source records. Missing scores fall back to baseline evidence. Recovery can omit useful material; improved recall in your harness has not been established.

See [setup and verification](SETUP.md) for installation checks and [TypeSafe model documentation](https://docs.typesafe.ai/models) for pricing. Text-size estimates are approximate, separate from API usage.
