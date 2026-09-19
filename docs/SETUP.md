# Agent-assisted setup

Start with the prompt for your harness in [the README](../README.md). Setup supports Windows, Linux, and macOS with Node.js 20+, Git, and npm. Use PowerShell on Windows.

## Choose the target

| Application | Target | Compatibility |
|---|---|---|
| Codex | `codex` | Hooks checked with terminal CLI 0.154.0. Requires human trust review. |
| Claude Code | `claude` | Requires Stop, PreCompact, and SessionStart hooks. |
| OpenCode v1 | `opencode` | Requires 1.18.29 or newer with the matching plugin API. Fixture coverage only. |
| OpenCode 2 | `opencode2` | Verified with synthetic compactions on 2.0.10. Beta `0.0.0-beta-19157` is unsupported. Check other versions against the required compaction API. |

## Install

These steps are for the installing agent.

1. Confirm the application and compatible version. Install missing prerequisites through an authorized user-scoped method. Report any blocker that needs privileges.
2. Use a persistent checkout at `~/.local/share/trashcompact`. If it exists, inspect its origin and working tree. Reuse a matching checkout, preserve local changes, and update only when a clean fast-forward is appropriate. Never overwrite an unrelated directory.
3. If the checkout is absent, create it:

   ```sh
   git clone https://github.com/roguefort-dev/TrashCompact.git "$HOME/.local/share/trashcompact"
   ```

4. Read its instructions, then install dependencies and the integration. Replace `TARGET` with the target above:

   ```sh
   cd "$HOME/.local/share/trashcompact"
   npm ci
   node install.mjs --target TARGET --non-interactive
   ```

   The installer preserves unrelated settings. It does not enter a key or approve platform trust.

Automatic scoring sends eligible assistant prose to TypeSafe. At compaction it also sends bounded assistant passages, the latest-user query, and source context. Codex and supported OpenCode integrations include bounded tool passages; Claude keeps tool results local. The README prompts authorize this processing. For other requests, explain this scope and obtain any missing authorization before enabling it.

## Human steps

Give the human the key-entry command with their actual absolute checkout path. For example:

```sh
node "/home/alex/.local/share/trashcompact/install/key.mjs"
```

On Windows, use their `C:/Users/...` checkout path. The human runs it in their terminal and enters the key into the hidden prompt. Never request the key in chat, read their credential file, pass the key in arguments, or run the helper for them. Wait for their confirmation before claiming key setup succeeded. The helper stores the key privately and makes no API request.

For Codex, give the human this command with their actual project path:

```sh
codex -C /absolute/path/to/their/project
```

Inside that terminal CLI, they run `/hooks` and review the TrashCompact Stop, PreCompact, and SessionStart hooks. `/hooks` in a desktop chat does not open this interface. Do not bypass trust review.

Restart your harness to load the integration. Follow any approval Claude Code displays. Report the installed target, configuration location, and remaining human steps.

## Verify

Use the synthetic fixture for an offline check:

```sh
node bin/launch.mjs example/codex-review.jsonl --format codex --plan
```

After key entry, existing API authorization permits this optional fixed synthetic check:

```sh
npm run self-test
```

It tests connectivity and scoring, not hook delivery or recall. Do not process real chats as installation tests or expose credentials during diagnosis. Installation leaves existing task history intact.

## Remove

From the checkout, replace `TARGET` with the installed target:

```sh
node install.mjs --target TARGET --uninstall --non-interactive
```

Restart your harness afterward. Removal preserves unrelated settings, the key, caches, and recovery data. OpenCode targets share one plugin and skill; removing either removes both integrations.

The optional [OpenCode 2 response companion](../opencode2/README.md) is Linux-only and has separate setup and removal instructions. The ordinary installer does not enable it.
