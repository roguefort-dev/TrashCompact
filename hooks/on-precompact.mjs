#!/usr/bin/env node
// Run a bounded Jev pre-pass, then stage offline recovery for after compaction.
// Codex ignores PreCompact plain stdout; this does not replace its summarizer.
import { runHook } from './common.mjs';
await runHook('precompact');
