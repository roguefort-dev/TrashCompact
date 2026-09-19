#!/usr/bin/env node
// Reset completed-compaction scores now; SessionStart supplies the staged note.
import { runHook } from './common.mjs';
await runHook('postcompact');
