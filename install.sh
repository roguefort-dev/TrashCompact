#!/usr/bin/env bash
# Idempotent local installation. Run key.sh separately for secret entry.
set -euo pipefail
TARGET=codex
REMOVE=false
NONINTERACTIVE=false
usage() {
  printf '%s\n' 'Usage: bash install.sh [--target codex|claude|opencode|opencode2] [--non-interactive] [--uninstall]' \
    'Prerequisites: Git, Node.js 20 or newer, npm. Uninstall needs only Node.js.' \
    'No automatic API verification. Keys and cached verdicts survive uninstall.'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --target) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; TARGET="$2"; shift ;;
    --non-interactive) NONINTERACTIVE=true ;;
    --uninstall) REMOVE=true ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
case "$TARGET" in codex|claude|opencode|opencode2) ;; *) usage >&2; exit 2 ;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null 2>&1 || { echo 'Install Node.js 20 or newer.' >&2; exit 1; }
[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 20')" = true ] || { echo 'Node.js 20 or newer is required.' >&2; exit 1; }
configure() {
  case "$TARGET" in
    codex|claude) node "$ROOT/install/configure.mjs" --target "$TARGET" "$@" ;;
    opencode|opencode2) node "$ROOT/opencode/install.mjs" --target "$TARGET" "$@" ;;
  esac
}
if "$REMOVE"; then
  configure --remove
  node "$ROOT/install/skills.mjs" --target "$TARGET" --remove
  echo 'Integration removed; API key and cached verdicts preserved.'
  exit 0
fi
for TOOL in git npm; do
  command -v "$TOOL" >/dev/null 2>&1 || { echo "Install $TOOL before continuing." >&2; exit 1; }
done
if [ ! -d "$ROOT/node_modules/@typesafe-ai/sdk" ]; then
  (cd "$ROOT" && if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi)
fi
chmod +x "$ROOT/bin/trashcompact" "$ROOT/bin/trashcompact-hook"
configure
node "$ROOT/install/skills.mjs" --target "$TARGET"
if ! "$NONINTERACTIVE" && [ -t 0 ] && [ ! -f "${TRASHCOMPACT_ENV:-$HOME/.config/typesafe/env}" ] && [ -z "${TYPESAFE_API_KEY:-}" ]; then
  bash "$ROOT/install/key.sh"
fi
printf 'Installed for %s. To enter or replace your API key, run in your terminal:\n' "$TARGET"
# POSIX single quoting is also accepted by fish. Never print the key itself.
node -e 'console.log("bash " + "\u0027" + process.argv[1].replaceAll("\u0027", "\u0027\\\u0027\u0027") + "\u0027")' "$ROOT/install/key.sh"
