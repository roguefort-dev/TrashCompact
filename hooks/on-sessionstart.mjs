#!/usr/bin/env node
// Deliver the staged note once after root-session compaction.
import { runHook } from './common.mjs';
await runHook('sessionstart');
