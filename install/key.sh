#!/usr/bin/env bash
# Read directly from the controlling terminal; never accept a key as an argument.
set +x
set -euo pipefail
[ "$#" -eq 0 ] || { echo 'Usage: bash install/key.sh' >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo 'Node.js 20 or newer is required.' >&2; exit 1; }
[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 20')" = true ] || { echo 'Node.js 20 or newer is required.' >&2; exit 1; }
if ! { exec 3<>/dev/tty; } 2>/dev/null; then
  echo 'Run this command in your own interactive terminal to enter the API key.' >&2
  exit 1
fi
printf 'TypeSafe API key (hidden; Enter skips): ' >&3
IFS= read -r -s TRASHCOMPACT_KEY_INPUT <&3 || { printf '\n' >&3; exit 1; }
printf '\n' >&3
if [ -z "$TRASHCOMPACT_KEY_INPUT" ]; then echo 'Key unchanged.'; exit 0; fi
printf '%s' "$TRASHCOMPACT_KEY_INPUT" | node "$ROOT/install/write-key.mjs"
unset TRASHCOMPACT_KEY_INPUT
