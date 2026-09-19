# Agent-assisted setup

Use the application-specific prompt in [the README](../README.md). These instructions let the agent perform setup while the human enters the API key privately and approves platform trust where required.

## Instructions for the installing agent

1. Identify the application and version. Use target `claude` for Claude Code, `codex` for Codex, `opencode` for OpenCode, or `opencode2` for OpenCode 2. Check that its hook/plugin API matches the integration. Do not assume an unrelated fork is compatible. OpenCode 2 `0.0.0-beta-19157` is unsupported for Jev compaction: it loads the plugin but never invokes the required compaction hook. Do not present setup on that beta as working. Setup supports Linux/macOS with Node.js 20+, Bash, Git, and npm. Resolve missing prerequisites using an available user-scoped version manager or installation method within the user’s authorization, preserving their existing setup. Handle routine prerequisite work yourself. Report an unsupported OS or a privileged installation blocker when no authorized user-scoped path is available; do not guess Windows equivalents. If an installed OpenCode version lacks the required API, explain the needed compatible upgrade instead of claiming successful integration.
2. Use `$HOME/.local/share/trashcompact` as a persistent checkout. If absent, create its parent and clone `https://github.com/roguefort-dev/TrashCompact.git` there. If it exists, inspect its origin and working tree first. Reuse a matching checkout; preserve dirty work, unrelated directories, and existing settings. Never reset or overwrite an existing checkout to make installation succeed. Use a fast-forward update only when appropriate for a clean matching checkout.
3. Read this checkout’s instructions. From the checkout, run `npm ci` using its committed lockfile. Then run `bash /absolute/path/to/trashcompact/install.sh --target TARGET --non-interactive`, substituting the confirmed target and real absolute path. The installer preserves unrelated hooks/settings. It does not enroll platform trust or require the API key.
4. Give the human the exact absolute terminal command `bash /absolute/path/to/trashcompact/install/key.sh`. Have them execute it themselves in their terminal. Do not run the interactive helper on their behalf, ask for the key in chat, inspect their credential file, or put the key in arguments. An external `bash` command also works from fish. The helper reads hidden input directly from `/dev/tty` and writes a private credential file. Do not claim the key was configured unless the human confirms completion.
5. Explain remaining trust/reload steps. Codex requires the human to review and trust the hooks through `/hooks` in the **Codex terminal CLI**. Typing `/hooks` into a Codex desktop chat does not execute that CLI interface. Give them `codex -C /absolute/path/to/their/project`, followed by `/hooks` inside that terminal session, and ask them to review the TrashCompact Stop, PreCompact, and SessionStart entries. The project can be unrelated to the TrashCompact checkout. Preserve this boundary; do not enable hooks by bypassing review. Reopen/restart the application to load the integration. Report which target and configuration were installed, and any remaining human action.
6. Do not process a real transcript as an installation test. Offline checks and synthetic fixtures are sufficient for setup. Optional online verification must use the fixed synthetic self-test below and existing authorization for an API request. Do not claim real-chat verification from a fixture or successful installer exit.

Installing these automatic integrations authorizes the documented processing: eligible assistant prose and, at compaction, bounded visible assistant passages, latest-user query, and source context are sent to TypeSafe. Codex and supported OpenCode integrations also send bounded tool passages for ranking. Claude does not rank tool-result passages online; recognized tool results remain eligible for local offline recovery evidence. The README installation prompts explicitly include this authorization. With other requests, explain that scope before enabling automatic processing if it is not already authorized.

## Human key entry

Run the command your agent gives you, for example with a checkout under `/home/alex`:

```sh
bash /home/alex/.local/share/trashcompact/install/key.sh
```

Paste the key only into that hidden terminal prompt. The default file is `~/.config/typesafe/env`, with mode `0600`. `TRASHCOMPACT_ENV` selects another file when deliberately configured for both setup and runtime. The launcher accepts `TYPESAFE_API_KEY` or a literal assignment in the credential file; it never executes that file as shell code. Offline modes do not load it. This command stores the key; it does not test the API.

## Integration and compatibility

| Target | Configuration and behavior |
|---|---|
| `codex` | `${CODEX_HOME:-~/.codex}/hooks.json`; Stop, PreCompact, and SessionStart hooks. Review through `/hooks`. Local compatibility was checked with Codex CLI 0.154.0. |
| `claude` | Claude Code settings under `~/.claude/settings.json`; Stop, PreCompact, and SessionStart hooks. Follow any approval shown by Claude Code. |
| `opencode` | A global `plugins/trashcompact.js` module in the OpenCode configuration directory, using `experimental.session.compacting` and `output.context`. Requires OpenCode 1.18.29 or newer with the matching plugin API; the installer rejects older v1 versions. |
| `opencode2` | The same global plugin module, using OpenCode 2’s compaction event and `event.system`. Requires a compatible version of `ctx.session.hook`; implementation follows the published plugin 2.0.10 contract. Beta `0.0.0-beta-19157` is unsupported. |

The OpenCode plugin supports both API shapes in one module; do not install duplicate plugins for the two targets. Both targets share the loader and skill under `${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/` and `opencode/skills/`. Removing either target removes this shared integration. The installer rejects known unsupported OpenCode 2 beta `0.0.0-beta-19157` and reports that other versions still need contract verification. Verify version compatibility rather than inferring it solely from the executable name. A successful loader import does not prove that compaction calls the plugin. An isolated OpenCode CLI 2.0.10 runtime completed two manual native compactions and delivered the recovery note in both summarization requests. That synthetic probe used a local mock model and scorer, with no live Jev or real chats. OpenCode v1 has fixture coverage only.

Codex and Claude score after completed turns, then prepare a bounded recovery snapshot before compaction. SessionStart after compaction supplies the recovery note. OpenCode supplies Jev-selected evidence to its native compaction context before summarization. Online scoring is time-bounded and failures fall back to offline evidence where possible. No integration promises complete retention or improved recall.

The [OpenCode 2 response companion](../opencode2/README.md) is an independent optional Linux systemd user service that triggers native compaction after completed responses. The ordinary installer does not enable it. It is not required for Jev integration at manual or automatic compaction boundaries.

## Verification

From the checkout, an offline synthetic inspection makes no API requests:

```sh
./bin/trashcompact example/codex-review.jsonl --format codex --plan
```

After key entry, the optional fixed synthetic API check is:

```sh
npm run self-test
```

This sends fixed synthetic text to TypeSafe, never a real transcript. It checks API connectivity and scoring, not platform hooks or downstream recall. Do not display credentials when diagnosing failures.

For an application smoke test, reopen/restart it, finish any trust review, use a disposable task, request native compaction, then send a new user message. Recovery is observable on the resumed turn. A configured hook, cached score, or successful request alone does not prove delivery. Installation does not rewrite an existing task’s history.

## Removal

Run the corresponding target from the same checkout:

```sh
bash /absolute/path/to/trashcompact/install.sh --target codex --uninstall --non-interactive
bash /absolute/path/to/trashcompact/install.sh --target claude --uninstall --non-interactive
bash /absolute/path/to/trashcompact/install.sh --target opencode --uninstall --non-interactive
bash /absolute/path/to/trashcompact/install.sh --target opencode2 --uninstall --non-interactive
```

Choose the line for the integration you installed. The `opencode` and `opencode2` targets share one plugin and skill; uninstalling either removes them for both. Removal preserves unrelated settings, the API key, local scoring caches, and recovery data. The installer preserves real skill directories; it removes only skill symlinks belonging to this checkout. Reopen/restart the application after removal. Remove any optional response companion separately using its guide.

Official contracts: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [OpenCode plugins](https://opencode.ai/docs/plugins), [OpenCode 2 plugins](https://opencode.ai/v2/docs/build/plugins).
