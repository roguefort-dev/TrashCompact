# TrashCompact

TrashCompact filters transcripts and selects compaction evidence for your harness using TypeSafe's Jev. See the supported integrations below.

## How it works

1. Static rules remove context bloat without added value for reasoning and problem solving efforts. Recognized failed tool exchanges expire after two user turns. Recognized Node test output keeps final totals and failures instead of individual passing-test lines. User messages are protected, with the last 5 records protected from general pruning and Jev scoring. Deterministic tool cleanup can bypass that tail.
2. Jev scores eligible standalone assistant prose. Low scores permit removal only when confidence meets the configured threshold. Jev cannot remove oversized, unscored, mixed, or unknown entries.
3. At compaction, Jev also ranks bounded passages for a recovery note of up to 6,000 UTF-8 bytes.

These removals affect filtered exports and recovery selection. The integrations leave live history and the native summarizer's transcript intact.

Failed scoring can fall back to cached judgments and unscored evidence. Recovery is incomplete. No real-task recall gain is established. See [compatibility and verification](docs/SETUP.md) for test coverage.

## Supported integrations

| Application | Integration |
|---|---|
| Codex | Stop scores completed turns. PreCompact prepares the note; SessionStart delivers it after compaction. Requires `/hooks` trust review. |
| Claude Code | Stop, PreCompact, and SessionStart hooks. |
| OpenCode v1 | Adds evidence through `experimental.session.compacting`. Requires 1.18.29 or newer with that API. |
| OpenCode 2 | Adds evidence through `ctx.session.hook('compaction')`. Verified with 2.0.10; beta `0.0.0-beta-19157` is unsupported. |

Codex and Claude Code receive the recovery note after compaction. OpenCode adds it to the summarizer's prompt. Codex and OpenCode support online ranking of bounded tool passages. Claude Code tool results remain local recovery evidence and are not ranked online.

## Ask your agent to install

Copy the block for your application into its chat. Setup supports Windows, Linux, and macOS with Node.js 20+, Git, npm, and a TypeSafe API key. On Windows, use PowerShell.

### Claude Code

```text
Install https://github.com/roguefort-dev/TrashCompact.git at ~/.local/share/trashcompact for Claude Code. Follow docs/SETUP.md with target claude, preserving existing files and settings. I authorize the documented automatic TypeSafe scoring. Give me the absolute key-entry command to run privately and any approval/restart steps. Never handle the key yourself.
```

### Codex

```text
Install https://github.com/roguefort-dev/TrashCompact.git at ~/.local/share/trashcompact for Codex. Follow docs/SETUP.md with target codex, preserving existing files and settings. I authorize the documented automatic TypeSafe scoring. Give me the absolute key-entry command to run privately and the terminal /hooks trust-review and restart steps. Never handle the key yourself.
```

### OpenCode and OpenCode 2

```text
Install https://github.com/roguefort-dev/TrashCompact.git at ~/.local/share/trashcompact for OpenCode. Follow docs/SETUP.md, check version compatibility, and select target opencode or opencode2. Preserve existing files and settings. I authorize the documented automatic TypeSafe scoring. Give me the private key-entry command and approval/restart steps. Never handle the key yourself or enable the optional response-compaction service.
```

The key helper reads hidden terminal input and stores it in `~/.config/typesafe/env`. Enter the key there yourself. Codex hook trust requires `/hooks` in its terminal CLI. Restart the application after setup; after manual compaction, send a new message to observe the resumed task.

## Data processing and reference

Automatic scoring sends eligible assistant prose to TypeSafe. Compaction ranking also sends bounded visible assistant passages, a latest-user query, and source context. Tool-passage processing depends on the [integration](#supported-integrations). Verdict caches store judgments and hashes; recovery snapshots store selected transcript excerpts.

- [Setup, compatibility, private key entry, and removal](docs/SETUP.md)
- [CLI flags, static rules, passage ranking, and limits](docs/CLI.md)
- [Optional OpenCode 2 response-compaction service](opencode2/README.md). This separate Linux service requests native summarization after completed responses.

MIT license.
