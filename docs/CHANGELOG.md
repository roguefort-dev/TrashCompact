# Changelog

## 2026-09-21

### Setup fixes

- Codex install instructions now require checking command discovery in a fresh macOS terminal shell, safely exposing an existing bundled CLI when needed, and verifying the fix before handing commands to the user.
- Key-entry and hook-review instructions use verified absolute executable paths. The single-request Codex prompt records a default update-check choice while preserving existing preferences.
- Clarified the scope of macOS verification: installation and offline checks passed; live hook delivery remains unverified.
