---
name: trashcompact
description: Score a Claude Code transcript for durable working knowledge and prune the noise, using TypeSafe's Jev.
disable-model-invocation: true
---

# TrashCompact

Prune a Claude Code transcript down to what a later reader actually needs. Three passes: one in code, two in [Jev](https://docs.typesafe.ai), TypeSafe's System One model.

The hooks installed by `install.sh` already do this continuously. Reach for this skill to run it by hand — inspect a transcript, produce a digest, or tune thresholds against real output.

## The passes

| Pass | Runs in | Question |
|---|---|---|
| 0 | code | Do these entries normalize to the same bytes? What is each entry *about*? |
| 1 | Jev | Is this durable working knowledge, routine output, or transient status? |
| 2 | Jev | Is everything this entry says already said by a **later** entry about the same thing? |

Pass 0 derives a **target key** by parsing the tool call behind each result — `tool:Read:src/env.ts`, `tool:Bash:npm test`. Pass 2 only compares entries sharing a key, so a file read is never judged against a test run. Untargeted prose gets a category from Jev inside the pass-1 request instead, riding the same state at near-zero extra cost.

Comparison is **directional**: an entry is only compared against entries that came after it. That keeps this O(n), and keeps it off the model's known weak ground — `jev-1.13` does not guarantee structural invariants between separate questions, so a symmetric `dup(a,b) == dup(b,a)` design would be building on sand.

## Running it

```bash
TC=~/Documents/TrashCompact/bin/trashcompact

$TC <transcript> --plan                          # what it would cost; no API calls
$TC <transcript> --update                        # score only new entries, cache verdicts
$TC <transcript> --offline --digest --out d.md   # readable digest from cache alone
$TC <transcript> --precompact                    # the compaction steering text
$TC <transcript> --out pruned.jsonl              # pruned transcript
```

Locate the current session's transcript — `-maxdepth 1` matters, or you pick up subagent transcripts:

```bash
find ~/.claude/projects/$(pwd | sed 's#/#-#g') -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2
```

## Reading the output

```
entries  23 → 11  (removed 12: 5 orphan-call, 4 noise, 1 redundant, 2 exact-repeat)
chars    1,308 → 909  (30.5% smaller)
jev      0 requests, 0 input tokens
```

- `noise` — pass 1 scored it as transient status
- `redundant` — pass 2 found a later entry carrying everything it says
- `exact-repeat` — pass 0; normalizes to an identical earlier entry
- `orphan-call` — a tool call whose every result was removed, so it carries nothing alone
- `empty` — no text content

`0 requests` means every verdict came from cache. That is the normal state once the Stop hook has been running.

## Tuning

Thresholds apply when results are read, never when they are scored — retuning is free and re-scores nothing.

| Flag | Default |
|---|---|
| `--keep-tail` | 20 |
| `--threshold` / `--min-confidence` | 0.75 / 0.55 |
| `--redundancy-threshold` / `--redundancy-confidence` | 0.6 / 0.7 |
| `--batch` / `--redundancy-batch` | 8 / 4 |
| `--siblings` | 3 |
| `--chars` | 1200 |

Both gates are asymmetric so that **uncertainty keeps**. An entry drops only when Jev is low-scoring *and* confident.

`--batch` is deliberately small. Inside a batch every other entry is a distractor, and Jev's documented failure mode #5 is that a large state full of irrelevant detail degrades accuracy. The headroom buys accuracy here, not throughput — cost is negligible either way.

## Limits that shape the design

- 64k tokens per request; 32k for state plus the longest single question
- Choice takes up to 255 options; Score takes 2–10 ordered levels
- `$0.042` per Mtok input, output free

## What this does not do

It does not intercept `/compact`, which is internal and unreachable from a skill — the PreCompact hook is the supported seam, and it steers the summariser rather than replacing it. It does not shrink the live context window; no hook can. And it never writes to its input.
