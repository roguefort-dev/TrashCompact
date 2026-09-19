# TrashCompact

TrashCompact filters transcripts and selects compaction evidence using TypeSafe's Jev for Claude Code, Codex, and compatible OpenCode versions.

## How it works

1. Before Jev scoring, static rules remove known local metadata, empty records, adjacent exact assistant repetitions, and complete tool call/result pairs for successful empty no-ops or exact repeated reads. User messages, failed tools, and the last 20 records are protected.
2. Jev scores eligible standalone assistant prose. Low scores permit removal only when confidence meets the configured threshold. Jev cannot remove oversized, unscored, mixed, or unknown entries.
3. At compaction, Jev also ranks bounded passages for a recovery note of up to 6,000 UTF-8 bytes. Tool-passage ranking is supported for Codex and OpenCode. Claude tool results remain local recovery evidence.

These removals affect filtered exports and recovery selection. The integrations leave live history and the native summarizer's transcript intact. Codex and Claude receive the recovery note after compaction. OpenCode adds it to the summarizer's prompt.

| Application | Integration |
|---|---|
| Codex | Stop scores completed turns. PreCompact prepares the note; SessionStart delivers it after compaction. Requires `/hooks` trust review. |
| Claude Code | Stop, PreCompact, and SessionStart hooks. |
| OpenCode v1 | Adds evidence through `experimental.session.compacting`. Requires 1.18.29 or newer with that API. |
| OpenCode 2 | Adds evidence through `ctx.session.hook('compaction')`. Verified with 2.0.10; beta `0.0.0-beta-19157` is unsupported. |

Failed scoring can fall back to cached judgments and unscored evidence. Recovery is incomplete. No real-task recall gain is established. See [compatibility and verification](docs/SETUP.md) for test coverage.

## Ask your agent to install

Copy the block for your application into its chat. Setup requires Linux or macOS, Node.js 20+, Bash, Git, npm, and a TypeSafe API key. Windows is unsupported.

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

Automatic scoring sends eligible assistant prose to TypeSafe. Compaction ranking also sends bounded visible assistant passages, a latest-user query, and source context. Codex and OpenCode include bounded plain-text tool passages. Verdict caches store judgments and hashes; recovery snapshots store selected transcript excerpts.

- [Setup, compatibility, private key entry, and removal](docs/SETUP.md)
- [CLI flags, static rules, passage ranking, and limits](docs/CLI.md)
- [Optional OpenCode 2 response-compaction service](opencode2/README.md). This separate Linux service requests native summarization after completed responses.

MIT license.
