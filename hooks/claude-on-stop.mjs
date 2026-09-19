#!/usr/bin/env node
import { runHook } from './common.mjs';
await runHook('stop', { format: 'claude' });
