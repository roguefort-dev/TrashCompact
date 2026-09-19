# TrashCompact

Preserve useful context across Claude Code, Codex, and OpenCode compaction with TypeSafe’s Jev. Your coding agent can install it; you enter your API key privately in a terminal and complete any required platform approval.

TrashCompact selects bounded historical evidence around the platform’s native compaction. It does not rewrite live conversation history or replace the native compactor.

## Ask your agent to install

Copy the block for your application into its chat. Setup requires Linux or macOS, Node.js 20+, Bash, Git, npm, and a TypeSafe API key. Windows and unrecognized platform variants are not covered by this setup.

**Claude Code**

```text
Install TrashCompact for Claude Code from https://github.com/roguefort-dev/TrashCompact.git into ~/.local/share/trashcompact. Read docs/SETUP.md and follow its agent installation instructions with target claude. Preserve existing files and settings. I authorize its documented automatic TypeSafe scoring. Give me the absolute bash install/key.sh command to enter my key privately in my terminal; never request, read, or handle the key in chat. Explain any remaining platform approval and restart steps.
```

**Codex**

```text
Install TrashCompact for Codex from https://github.com/roguefort-dev/TrashCompact.git into ~/.local/share/trashcompact. Read docs/SETUP.md and follow its agent installation instructions with target codex. Preserve existing files and settings. I authorize its documented automatic TypeSafe scoring. Give me the absolute bash install/key.sh command to enter my key privately in my terminal; never request, read, or handle the key in chat. Leave required /hooks trust review to me and explain restart steps.
```

**OpenCode / OpenCode 2**

OpenCode 2 `0.0.0-beta-19157` is **unsupported for Jev compaction**: it loads plugins but never invokes the required compaction hook. Use a compatible release; plugin loading alone is not verification.

```text
Install TrashCompact from https://github.com/roguefort-dev/TrashCompact.git into ~/.local/share/trashcompact. Read docs/SETUP.md and identify my OpenCode version and its supported plugin API before selecting target opencode or opencode2. Preserve existing files and settings. I authorize its documented automatic TypeSafe scoring. Give me the absolute bash install/key.sh command to enter my key privately in my terminal; never request, read, or handle the key in chat. Explain any remaining approval and restart steps. Do not enable the optional response-compaction service.
```

The key command reads hidden input from your terminal and stores it privately in `~/.config/typesafe/env`. Do not paste the key into chat, command arguments, or a repository file. In Codex, review and trust the installed hooks through `/hooks` in the terminal CLI (not desktop chat); your agent will give you the command to open it. Installation cannot bypass that approval. Reopen or restart your application after setup so it loads the integration.

**Processing scope:** automatic scoring sends eligible assistant prose to TypeSafe. Compaction scoring also sends bounded visible assistant passages, a latest-user query, and short source context. Codex and supported OpenCode integrations also rank bounded plain-text tool passages. Claude tool results can appear in local recovery evidence but are not sent for tool-passage ranking. Local private caches and recovery notes retain selected historical evidence. Install only where that processing is appropriate; the CLI supports offline inspection. See [setup and removal](docs/SETUP.md) for exact commands.

## What each integration does

| Application | Integration |
|---|---|
| Codex | Asynchronous Stop scoring; synchronous PreCompact scoring and offline snapshot; SessionStart after compaction delivers recovery context. Required `/hooks` trust review. |
| Claude Code | Stop scoring; PreCompact scoring and snapshot; SessionStart after compaction delivers recovery context using Claude’s hook contract. |
| OpenCode | Jev-selected evidence is added through its compaction plugin hook before native summarization. |
| OpenCode 2 | Jev-selected evidence is supplied through its supported compaction plugin API. Version compatibility must be checked during setup. |

Codex ignores plain PreCompact stdout: its recovery note arrives after native compaction and does not feed the summarizer. The Codex/Claude recovery note is capped at 6,000 UTF-8 bytes and supplements the native summary. If online scoring fails, recovery can still use cached judgments and conservative unscored evidence. Recovery is incomplete and historical statements may conflict.

After manually compacting a task, send a new user message to observe the resumed task. Installing TrashCompact alone does not compact or rewrite an already-open conversation.

## Verification and further reading

Native Codex hook delivery has been verified end to end in an actual session. This verifies integration delivery, not improved recall or performance. Claude and OpenCode support have focused automated coverage. An isolated OpenCode CLI 2.0.10 runtime completed two manual native compactions, and both summarization requests contained the plugin’s recovery note. That synthetic test used a local mock model and scorer, not live Jev or real chats. OpenCode v1 has fixture coverage only; the older OpenCode 2 beta listed above lacks the required hook.

- [Agent setup, private key entry, verification, and uninstall](docs/SETUP.md)
- [CLI flags, passage ranking, retention, and evaluation limitations](docs/CLI.md)
- [Optional OpenCode 2 response-compaction companion](opencode2/README.md): a separate Linux user service that requests native summarization after completed responses. It is not enabled by the setup above.

MIT license.
