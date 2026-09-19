# CLI, selection, and validation

## Run by hand

```bash
./bin/trashcompact example/codex-review.jsonl --format codex --plan
./bin/trashcompact example/codex-review.jsonl --format codex --update --keep-tail 0
./bin/trashcompact example/codex-review.jsonl --format codex --recovery --keep-tail 0
./bin/trashcompact <rollout.jsonl> --format codex --offline --digest --out digest.md
```

The example fixture is synthetic. The second command sends its eligible text to TypeSafe. `--plan`, `--offline`, and `--recovery` make no API requests. For comparable runs, use the same tail protection and model settings.

Use an explicit rollout path supplied by the active task/hook. Do not select the newest arbitrary rollout: other tasks and subagents may be active. Codex's rollout format is version-sensitive; unexpected content is preserved rather than guessed into assistant prose.

| Flag | Default | Meaning |
|---|---|---|
| `--format` | `auto` | Recognize Codex or Claude input; choose a format explicitly for hooks |
| `--keep-tail N` | 20 | Protect the last N records from all removal passes |
| `--threshold N` | 0.75 | Drop below this value on the three-level 0–2 score scale |
| `--min-confidence N` | 0.55 | Minimum confidence on the 0–1 scale before dropping |
| `--batch N` | 8 | Maximum entries per Jev request; byte budgets may split it further |
| `--chars N` | 1200 | Full-entry length eligibility limit; longer entries stay intact |
| `--model ID` | `jev-1.13.0` | Version-pinned default; `TYPESAFE_DEFAULT_MODEL` can override it |
| `--state PATH` | Under Codex's `trashcompact/` directory | Override the per-transcript verdict cache |
| `--recovery-rank` | Off | Experimental cached Jev ranking of bounded recovery passages; only `--update` scores online |
| `--recovery` | Off | Offline bounded evidence note for post-compaction recovery |
| `--offline` | Off | Retain unknown verdicts without contacting Jev |
| `--full-log` | Off | Compatibility flag; conservative analysis already retains history |

Claude input is also supported. `--precompact` emits legacy Claude-oriented steering text; installed integrations use their own platform delivery contracts.

## Optional passage ranking

Passage ranking remains experimental. It is off by default for standalone CLI commands and enabled by the compaction hook. It expands TypeSafe processing to bounded excerpts of visible assistant text and plain-text tool outputs, plus a bounded latest-user query and short original source context. It changes recovery-note selection only; raw records and the normal whole-entry retention policy stay intact.

```bash
./bin/trashcompact <rollout.jsonl> --plan --recovery-rank
./bin/trashcompact <rollout.jsonl> --update --recovery-rank
./bin/trashcompact <rollout.jsonl> --recovery --recovery-rank
```

Use the same model and flags to reuse judgments. `--plan` reports candidate/cache counts and a source/query byte bound without sending anything. `--recovery`, `--offline`, and `--plan` never make ranking requests. The installed PreCompact hook explicitly enables `--recovery-rank`; `TRASHCOMPACT_FLAGS` can tune supported scoring parameters.

The shortlist reserves assistant and tool sources, with at most 96 exact source passages from 32 source fields, eight passages per field, 640 bytes per passage, 160 bytes of source context and up to 480 bytes of safe tool name/command/working-directory context, a 1,200-byte user query, and 24 chronological same-subject candidate pairs. Query/diagnostic matches and distributed spans provide bounded coverage of long middles. Coverage is still incomplete. The default batch size is eight judgments, or at most 15 ranking requests before byte limits. A 30,000-byte serialized request cap can split batches, up to the 120-job bound. Oversized single jobs stay unjudged. Hidden/routed/mixed unknown sources, obvious credentials, and opaque encoded payloads are excluded from expanded processing.

Cached passage scores of at least 1 on the 0–2 scale and valid confidence metadata may replace optional baseline excerpts. User constraints and the current final answer retain priority inside the same 6,000-byte note. A same-claim `supersedes` judgment needs confidence at least 0.95, explicit replacement evidence, and the exact newer passage actually rendered before an older passage is omitted. Plans and generic passed tests cannot establish resolution; uncertain, unrelated, and coexisting claims remain eligible. Supersession never deletes a whole mixed-claim record. Missing or stale judgments use the baseline. A low-concentration Score can still prefer useful evidence; high confidence remains mandatory for supersession. These thresholds are conservative implementation choices, not guarantees of correctness or demonstrated gains in native Codex recall.

## Retention and cache behavior

Static rules run before Jev. They remove known local metadata, empty records, and exact adjacent assistant-prose repetitions in the same turn. Tool pruning removes complete call/result pairs only when the recognized schema establishes one of these cases:

- A successful literal `true`, `:`, `clear`, or numeric `sleep` command returned empty output.
- A read-only exchange exactly repeats the same tool, arguments, absolute working directory, and output in the same user turn. Supported forms are literal `cat` commands and Claude `Read`, `Glob`, and `Grep` exchanges. The later pair survives. Unknown or mutating tool calls break repeat tracking.

Both sides of a removed pair must precede the protected tail. Incomplete, failed, mixed, and unrecognized exchanges stay. User messages, summaries, other tool evidence, and the protected tail survive these rules. Removal changes filtered exports and recovery selection; integrations leave native history intact.

The standalone CLI judges eligible standalone assistant text; compaction also enables bounded passage ranking. Jev-based removal requires both a low score and sufficient confidence. Intent labels cannot bypass confidence, and scoring a prefix cannot authorize deleting a longer entry.

Whole-entry cache identities include content, model, question definitions, and character budget. Passage-ranking identities also include the latest-user query and source context. Threshold changes reuse raw scores; changed queries or scoring configuration may require new requests. Caches store judgments and hashes, while recovery snapshots store transcript excerpts. Cache writes use atomic replacement and a short merge lock. Concurrent scorers may still duplicate requests. A crashed writer can leave a lock that needs removal after confirming no writer remains.

The online PreCompact pre-pass has a 45-second budget, followed by a 10-second offline rendering budget. Offline rendering still runs using the existing cache and unscored evidence, so coverage may be incomplete. Recovery hooks fail open on invalid input or failed snapshot preparation. Neither confidence nor a cached score guarantees semantic correctness.

## Validation and limitations

```bash
npm test
```

Tests use synthetic transcripts, mocked scoring, and temporary homes. Run them from a repository checkout; test sources are not included in the npm package.

The parser conservatively analyzes history rather than guessing that everything before a summary marker is absent from live context. This can increase initial scoring and include historical material. Text-size reporting is a characters/4 heuristic, not measured context savings. Automatic native Codex hook delivery has been verified end to end in an actual session. That establishes hook delivery, not improved downstream recall; real-task performance gains remain unverified. Passage ranking remains optional in standalone CLI commands and is enabled in the compaction-only hook workflow.

See [TypeSafe model documentation](https://docs.typesafe.ai/models) for pricing. The CLI reports API usage separately from text-size estimates.
