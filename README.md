# TrashCompact

Take the trash out of your Claude Code context.

Long sessions fill up with entries that carry no working knowledge — `process finished with exit code 0`, progress pings, the third read of a file you already read, a directory listing from twenty turns ago. When compaction finally runs, all of that competes for the summariser's attention with the things that actually mattered: the decision you made, the error and its cause, the constant that broke the build.

TrashCompact scores every entry in your transcript for durable working knowledge using [TypeSafe](https://typesafe.ai)'s **Jev** — a System One model that returns typed judgments with calibrated confidence instead of generated text — and uses the result to steer Claude Code's own compaction.

```
entries  389 → 174  (removed 215: 96 noise, 61 redundant, 38 orphan-call, 20 exact-repeat)
chars    412,880 → 168,204  (59.3% smaller)
```

## Install

```bash
git clone https://github.com/roguefort-dev/TrashCompact.git
cd TrashCompact
./install.sh
```

The installer checks your Node version, installs the SDK, asks for a TypeSafe API key (hidden input, written to `~/.config/typesafe/env` with mode `0600`, never to this repo), verifies the key with one live call, links the skill, and wires the hooks. It is idempotent — re-run it any time.

Hooks are live in new sessions. In a session that is already open, run `/hooks` once to reload.

```bash
./install.sh --uninstall   # removes hooks and skill; leaves your key and cache alone
```

## How it works

Three passes, two of which are free.

| Pass | Runs in | Does |
|---|---|---|
| 0 | code | Collapses entries that normalize to the same bytes, and derives each entry's **target key** — what it is *about*, parsed from the tool call that produced it (`tool:Read:src/env.ts`) |
| 1 | Jev | Scores **retention**: is this durable working knowledge, routine output, or transient status? |
| 2 | Jev | Scores **redundancy**: is everything this entry says already said by a later entry on the same target key? |

Two design choices make this cheap and reliable:

**Redundancy is directional.** An entry is only ever compared against entries that came *after* it. That removes any need for the model to be symmetric or transitive — [`jev-1.13` documents that structural invariants across separate questions are not guaranteed](https://docs.typesafe.ai) — and turns what looks like an O(n²) dedup into O(n).

**Comparison is shortlisted in code.** Because pass 0 already knows an entry's target key, pass 2 only ever compares entries about the same thing. A read of `src/env.ts` is never judged against a test run.

## Incremental by default

The Stop hook scores only the entries the turn just appended. Verdicts are cached by entry uuid in `~/.claude/trashcompact/`, so nothing is ever judged twice:

```
run 1   +5 scored,  0 cached,  1 requests, ~$0.0001
run 2   +6 scored,  5 cached,  2 requests, ~$0.0001
run 3   +0 scored, 11 cached,  0 requests, ~$0.0000     ← nothing new, nothing spent
```

Retention is final on arrival — an entry's own value does not change because later entries exist. Redundancy is re-checked only when a **new entry lands on the same target key**, which is one question, not a rescan.

By the time compaction fires, every verdict is already paid for, so the PreCompact hook runs **fully offline**: no latency, no cost, at the exact moment the context is full and you are waiting.

## What it does and does not do

**It steers compaction.** Claude Code merges a PreCompact hook's stdout into the summariser's instructions. TrashCompact uses that to name what must survive and to say how much of the session was noise.

**It does not shrink the live context window.** No hook can — Claude Code's hook outputs can add context, gate a tool, or block, but nothing removes messages already in the window. Anything claiming otherwise is selling you something. The win here is that when compaction *does* happen, it keeps the right things.

**It never mutates your transcript.** The input file is read-only, always.

## Using it by hand

The skill is user-invoked (`/trashcompact`), and the CLI works standalone:

```bash
./bin/trashcompact ~/.claude/projects/<slug>/<session>.jsonl --plan       # cost estimate, no API calls
./bin/trashcompact <transcript> --update                                  # score new entries, cache them
./bin/trashcompact <transcript> --offline --digest --out digest.md        # readable digest from cache
./bin/trashcompact <transcript> --precompact                              # the steering text, offline
```

Find the current session's transcript:

```bash
ls -t ~/.claude/projects/$(pwd | sed 's#/#-#g')/*.jsonl | head -1
```

## Tuning

Thresholds are applied when results are *read*, not when they are scored — so retuning costs nothing and re-scores nothing.

| Flag | Default | Does |
|---|---|---|
| `--keep-tail N` | 20 | Never judge the last N entries |
| `--threshold` | 0.75 | Retention score below which an entry is dropped |
| `--min-confidence` | 0.55 | Confidence required before a drop is honoured |
| `--redundancy-threshold` | 0.6 | Redundancy score below which an entry is dropped |
| `--redundancy-confidence` | 0.7 | Confidence required for a redundancy drop |
| `--batch N` | 8 | Entries per request |
| `--siblings N` | 3 | Later entries an entry is compared against |
| `--no-dedup` | — | Skip pass 2 |

Both gates are asymmetric on purpose: **uncertainty keeps, it never drops.** An entry Jev is unsure about stays in.

Apply flags to the hooks:

```bash
export TRASHCOMPACT_FLAGS="--keep-tail 40 --threshold 0.8"
```

## Cost

Jev bills `$0.042` per million input tokens; output is free. A 1,600-entry session costs well under a cent to score in full, and the incremental hook spreads even that across turns.

## What gets sent where

TrashCompact sends transcript entry text to the TypeSafe API to score it. With the Stop hook installed this happens automatically, every turn, without a per-run prompt. **If you work on code you cannot send to a third party, do not install the hooks** — use the CLI by hand on the transcripts you choose.

Your API key is read from `~/.config/typesafe/env` (mode `0600`), outside the repo. It is never passed as a command argument, never logged, and `.gitignore` covers the usual ways a credential ends up in a commit.

## Requirements

- Node 18+
- Claude Code
- A [TypeSafe](https://typesafe.ai) API key

## License

MIT
