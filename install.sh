#!/usr/bin/env bash
# Compatibility wrapper. The installer itself runs on Node.js on every platform.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$ROOT/install.mjs" "$@"
