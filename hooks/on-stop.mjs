#!/usr/bin/env node
// Runs asynchronously to score newly appended entries, without disrupting the turn.
import { runHook } from './common.mjs';
await runHook('stop');
