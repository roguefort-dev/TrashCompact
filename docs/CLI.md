# CLI guide

Run these commands from the checkout. The example transcript is synthetic.

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

## Common flags

| Flag | Default | Effect |
|---|---|---|
| `--format` | `auto` | Detect Codex or Claude input. Use an explicit format in hooks. |
| `--keep-tail N` | `5` | Protect the last N records from general pruning and Jev scoring. |
| `--threshold N` | `0.75` | Drop scores below N on the 0–2 scale, if confidence is sufficient. |
| `--min-confidence N` | `0.55` | Minimum confidence for removal, on the 0–1 scale. |
| `--batch N` | `8` | Maximum entries per scoring request. |
| `--chars N` | `1200` | Keep longer entries intact without whole-entry scoring. |
| `--model ID` | `jev-1.13.0` | Choose a model. `TYPESAFE_DEFAULT_MODEL` can override the default. |
| `--state PATH` | Per-transcript cache | Choose another cache file. |

## Retention and cache behavior

Static rules run before Jev. They remove known local metadata, empty records, and exact adjacent assistant-text repetitions within a turn. Recognized tool cleanup can bypass tail protection:

- Remove complete successful no-op exchanges with empty output.
- Keep only the later identical read-only exchange in the same user turn, for supported literal `cat` and Claude `Read`, `Glob`, and `Grep` calls.
- Keep recognized failed exchanges until two later user turns have begun.
- Remove individual passing-test lines from complete, recognized Node TAP or spec reports. Keep final totals, failures, and unrecognized lines.

Unknown, mixed, incomplete, or truncated exchanges stay. User messages and summaries remain protected. Jev removes eligible assistant text only when both the score and confidence permit it.

Caches reuse judgments when the text and scoring settings match, while changed recovery queries or context may need new scores.

## Experimental recovery ranking

Add `--recovery-rank` to enable passage ranking. It is off for standalone commands and enabled by installed compaction hooks. Only `--update` sends ranking requests.

Ranking sends bounded visible assistant passages, the latest-user query, and source context to TypeSafe. Codex and supported OpenCode integrations also send bounded tool passages. Claude tool results remain local recovery evidence.

Ranking changes the selection of excerpts for a recovery note of at most 6,000 bytes. It does not delete source records. Missing scores fall back to baseline evidence. Recovery can omit useful material; improved recall in your harness has not been established.

See [setup and verification](SETUP.md) for installation checks and [TypeSafe model documentation](https://docs.typesafe.ai/models) for pricing. Text-size estimates are approximate, separate from API usage.
