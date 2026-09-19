#!/usr/bin/env node
import { runHook } from './common.mjs';
await runHook('sessionstart', { format: 'claude' });
