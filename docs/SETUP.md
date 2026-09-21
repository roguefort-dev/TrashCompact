# Agent-assisted setup

Start with the prompt for your harness in [the README](../README.md). Setup requires Node.js 20+, Git, and npm. Full hook lifecycle tested on Linux. Codex installation, terminal CLI discovery, and the offline fixture check also verified on macOS; live macOS hook delivery and Windows remain unverified. Please submit a [pull request](https://github.com/roguefort-dev/TrashCompact) with fixes if you encounter issues. Use PowerShell on Windows.

## Choose the target

| Application | Target | Compatibility |
|---|---|---|
| Codex | `codex` | Installed lifecycle checked on Linux with Codex 0.154.0; see verification scope below. Requires human trust review. |
| Claude Code | `claude` | Requires Stop, PreCompact, and SessionStart hooks. |
| OpenCode v1 | `opencode` | Requires 1.18.29 or newer with the matching plugin API. Fixture coverage only. |
| OpenCode 2 | `opencode2` | Verified with synthetic compactions on 2.0.10. Beta `0.0.0-beta-19157` is unsupported. Check other versions against the required compaction API. |

## Install

These steps are for the installing agent.

1. Install the [TypeSafe agent skill](https://docs.typesafe.ai/agent-skill#installation) globally for the selected application, reusing an existing installation, and read it before continuing.
2. Confirm the application and compatible version. Install missing prerequisites through an authorized user-scoped method. For Codex on macOS, complete the [terminal preflight](#macos-codex-terminal-preflight) before handing the human any commands. Report any blocker that needs privileges.
3. Use a persistent checkout at `~/.local/share/trashcompact`. If it exists, inspect its origin and working tree. Reuse a matching checkout, preserve local changes, and update only when a clean fast-forward is appropriate. Never overwrite an unrelated directory.
4. If the checkout is absent, create it:

   ```sh
   git clone https://github.com/roguefort-dev/TrashCompact.git "$HOME/.local/share/trashcompact"
   ```

5. Read its instructions, then install dependencies and the integration. Replace `TARGET` with the target above:

   ```sh
   cd "$HOME/.local/share/trashcompact"
   npm ci
   node install.mjs --target TARGET --non-interactive
   ```

   The installer preserves unrelated settings. It does not enter a key or approve platform trust.

6. Honor an explicit update-check choice in the install request without asking again. Otherwise offer update checks once during installation, unless `~/.trashcompact/updates/config.json` already records an `enabled` boolean. Preserve either saved choice on reinstall. Ask: "Do you want me to enable update checks? They run during the first successful online Jev scoring pass of the day, at a completed turn or compaction. No background services are necessary." This means the first successful incremental `--update` pass per local calendar day. Use `node /absolute/path/to/trashcompact/bin/updates.mjs enable` only after a yes or existing explicit authorization. For a no, use the same command with `disable` to save the choice. With no answer, leave checks off and continue setup. Use the actual checkout path and quote it if needed. Checks never install updates automatically.

Automatic scoring sends eligible assistant prose to TypeSafe. At compaction it also sends bounded assistant passages, the latest-user query, and source context. Codex and supported OpenCode integrations include bounded tool passages; Claude keeps tool results local. The README prompts authorize this processing. For other requests, explain this scope and obtain any missing authorization before enabling it.

## macOS Codex terminal preflight

The desktop agent's `PATH` can differ from Terminal's. A successful `command -v codex` inside the agent does not prove that the user can run `codex`. Complete this preflight as part of the original install request; do not leave a predictable `command not found` error for the human to diagnose.

1. Check command discovery and versions in a fresh interactive login shell with a minimal starting environment. On a standard macOS zsh setup:

   ```sh
   /usr/bin/env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/zsh -lic 'command -v codex && codex --version && command -v node && node --version'
   ```

   If the user uses another shell or a custom startup-file location, use that actual configuration. This checks shell startup files without inheriting the desktop agent's extra search paths.

2. If Codex is missing there, inspect the existing installation before installing another copy. Inspect `command -v codex` in the agent environment and the actual installed app bundle. On the verified Mac, the bundled executable was `/Applications/ChatGPT.app/Contents/Resources/codex`; this is an observed path, not a guaranteed app name or location. Check that the discovered file is executable and that its absolute `--version` command succeeds. If no CLI is installed, use current official Codex installation guidance.

3. Make the verified executable available through the user's command path. If `~/.local/bin` is already on their terminal `PATH`, create `~/.local/bin/codex` as a symlink to the discovered executable. Create the directory if needed. Use a non-overwriting operation such as `ln -s` without `-f`; inspect any existing file or symlink, including a dangling symlink, and preserve unrelated installations. If the directory is not on `PATH`, add it once to the appropriate shell startup file, preserving existing configuration. For zsh, an example is `export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc`. Do not edit global shell configuration or require administrator access for this shortcut.

4. Repeat the fresh-shell check and require successful Codex and Node.js version output (Node.js 20+). Verify the actual absolute Node executable used for key entry as well. Give the user absolute executable paths for the remaining commands so their already-open terminal does not need to reload `PATH`. If a new terminal is needed for the short `codex` command, say so. An app move or uninstall can invalidate a symlink into its bundle; recheck its target on reinstall.

This preflight fixes terminal command discovery. It does not verify that the desktop hook process can resolve Node.js or that trusted hooks deliver recovery notes; report those separately after a real lifecycle check.

## Human steps

Give the human the key-entry command with their actual absolute checkout path and verified absolute Node.js executable. For example (replace both paths):

```sh
"/absolute/path/to/node" "/home/alex/.local/share/trashcompact/install/key.mjs"
```

On Windows, use their actual executable and `C:/Users/...` checkout paths, and prefix a quoted executable with PowerShell’s call operator `&`. Apply the same PowerShell syntax to the Codex launch command below. The human runs it in their terminal and enters the key into the hidden prompt. Never request the key in chat, read their credential file, pass the key in arguments, or run the helper for them. Wait for their confirmation before claiming key setup succeeded. The helper stores the key privately and makes no API request.

For Codex, give the human a command with the verified absolute Codex executable and their actual project path (quote both):

```sh
"/absolute/path/to/codex" -C "/absolute/path/to/their/project"
```

Inside that terminal CLI, they run `/hooks` and review the TrashCompact Stop, PreCompact, PostCompact, and SessionStart hooks. `/hooks` in a desktop chat does not open this interface. Do not bypass trust review.

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

Testing in authorized Codex desktop tasks verified immediate PostCompact cache reset after native compaction while preserving the recovery note, before another user turn. It also verified SessionStart recovery delivery and fallback reset, automatic Stop scoring, and cache reuse without additional requests. This live verification applies to Codex 0.154.0 on Linux.

The macOS installation check used Node.js 24.17.0 and Codex 0.155.0-alpha.9.2. The clean-shell command initially failed to find Codex, then passed after adding a user-local symlink to the existing app-bundled CLI. The offline synthetic plan passed. API scoring and the macOS hook lifecycle were not verified by these checks.

## Remove

From the checkout, replace `TARGET` with the installed target:

```sh
node install.mjs --target TARGET --uninstall --non-interactive
```

Restart your harness afterward. Removal preserves unrelated settings, the key, caches, and recovery data. OpenCode targets share one plugin and skill; removing either removes both integrations.

The optional [OpenCode 2 response companion](../opencode2/README.md) is Linux-only and has separate setup and removal instructions. The ordinary installer does not enable it.

Stop reuses judgments between turns; native compaction expires them for fresh scoring. See [cache behavior](CLI.md#retention-and-cache-behavior).
