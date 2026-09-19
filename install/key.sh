#!/usr/bin/env bash
# Compatibility wrapper. The Node helper owns hidden terminal input.
set +x
set -euo pipefail
[ "$#" -eq 0 ] || { echo 'Usage: bash install/key.sh' >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo 'Node.js 20 or newer is required.' >&2; exit 1; }
exec node "$ROOT/install/key.mjs"
