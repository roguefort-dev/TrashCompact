#!/usr/bin/env bash
# TrashCompact installer.
#
#   ./install.sh              install: deps, API key, hooks, skill
#   ./install.sh --uninstall  remove hooks and the skill (never touches your key)
#
# Safe to re-run: every step is idempotent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${TRASHCOMPACT_ENV:-$HOME/.config/typesafe/env}"
SKILL_NAME="trashcompact"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- uninstall --
if [ "${1:-}" = "--uninstall" ]; then
  bold "Removing TrashCompact"
  node "$ROOT/install/configure.mjs" --remove >/dev/null && ok "hooks removed from ~/.claude/settings.json"
  for dir in "$HOME/.claude/skills" "$HOME/.agents/skills" "$HOME/.codex/skills"; do
    if [ -e "$dir/$SKILL_NAME" ] || [ -L "$dir/$SKILL_NAME" ]; then
      rm -rf "$dir/$SKILL_NAME"
      ok "skill removed from $dir"
    fi
  done
  printf '\n'
  warn "your API key in $ENV_FILE was left alone"
  warn "cached verdicts in ~/.claude/trashcompact were left alone"
  exit 0
fi

bold "Installing TrashCompact"
printf '\n'

# -------------------------------------------------------------------- node --
command -v node >/dev/null 2>&1 || die "node not found. Install Node 18 or newer, then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node $NODE_MAJOR is too old. TrashCompact needs 18 or newer."
ok "node $(node -p 'process.versions.node')"

# ---------------------------------------------------------------- deps --
if [ ! -d "$ROOT/node_modules/@typesafe-ai/sdk" ]; then
  printf '  … installing @typesafe-ai/sdk\n'
  (cd "$ROOT" && npm install --silent --no-audit --no-fund) || die "npm install failed"
fi
ok "@typesafe-ai/sdk present"

chmod +x "$ROOT/bin/trashcompact" "$ROOT/bin/trashcompact-hook" 2>/dev/null || true

# ----------------------------------------------------------------- api key --
# The key is read straight from your terminal into a 0600 file outside the repo.
# It is never echoed, never passed as an argument, and never committed.
have_key() {
  [ -n "${TYPESAFE_API_KEY:-}" ] && return 0
  [ -r "$ENV_FILE" ] && grep -q '^TYPESAFE_API_KEY=.\+' "$ENV_FILE" && return 0
  return 1
}

if have_key; then
  ok "API key already configured ($ENV_FILE)"
else
  printf '\n'
  bold "TrashCompact needs a TypeSafe API key"
  printf '  Get one at https://typesafe.ai — the free tier is enough to try this.\n'
  printf '  Paste it here (input is hidden), or press Enter to skip for now.\n\n'
  printf '  API key: '
  read -rs TYPESAFE_KEY_INPUT || true
  printf '\n\n'
  if [ -n "${TYPESAFE_KEY_INPUT:-}" ]; then
    mkdir -p "$(dirname "$ENV_FILE")"
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    # Replace any existing line rather than appending a second one.
    if grep -q '^TYPESAFE_API_KEY=' "$ENV_FILE" 2>/dev/null; then
      tmp="$ENV_FILE.tmp.$$"
      grep -v '^TYPESAFE_API_KEY=' "$ENV_FILE" > "$tmp" || true
      mv "$tmp" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
    fi
    printf 'TYPESAFE_API_KEY=%s\n' "$TYPESAFE_KEY_INPUT" >> "$ENV_FILE"
    unset TYPESAFE_KEY_INPUT
    ok "key written to $ENV_FILE (mode 0600)"
  else
    warn "skipped — add it later with:  ./install.sh"
  fi
fi

# ------------------------------------------------------------- verify key --
if have_key; then
  printf '  … verifying key\n'
  if "$ROOT/bin/trashcompact" --self-test >/dev/null 2>&1; then
    ok "key works"
  else
    warn "could not reach the TypeSafe API with that key — hooks are installed but will no-op"
  fi
fi

# ------------------------------------------------------------------ skill --
for dir in "$HOME/.claude/skills" "$HOME/.agents/skills"; do
  mkdir -p "$dir"
  rm -rf "${dir:?}/$SKILL_NAME"
  ln -s "$ROOT/skill" "$dir/$SKILL_NAME"
  ok "skill linked into $dir"
done
if [ -d "$HOME/.codex/skills" ]; then
  rm -rf "$HOME/.codex/skills/$SKILL_NAME"
  cp -r "$ROOT/skill" "$HOME/.codex/skills/$SKILL_NAME"
  ok "skill copied into ~/.codex/skills (Codex reads copies, not symlinks)"
fi

# ------------------------------------------------------------------ hooks --
node "$ROOT/install/configure.mjs" >/dev/null && ok "hooks wired into ~/.claude/settings.json"

printf '\n'
bold "Done."
cat <<EOF

  Stop hook        scores each turn's new entries in the background
  PreCompact hook  steers Claude Code's compaction with what it found

  Both are live in new sessions. In a session that is already open, run
  /hooks once to reload the config.

  Try it by hand:
    ./bin/trashcompact <transcript.jsonl> --plan

  Tune it without re-scoring anything (thresholds apply at read time):
    export TRASHCOMPACT_FLAGS="--keep-tail 40 --threshold 0.8"

  Uninstall:
    ./install.sh --uninstall

EOF
