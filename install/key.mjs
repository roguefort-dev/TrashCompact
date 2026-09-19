#!/usr/bin/env node
// Run this in the human's own terminal. Never accept a key through arguments.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { savePrivateKey } from './write-key.mjs';

export function readPrivateKey({ input = process.stdin, output = process.stderr, signals = process } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('Run this command in your own interactive terminal to enter the API key.'));
  }
  return new Promise((resolveKey, reject) => {
    const wasRaw = !!input.isRaw;
    const decoder = new StringDecoder('utf8');
    let value = '';
    let done = false;
    const cancelled = () => finish(new Error('Key entry cancelled. Key unchanged.'));
    const closed = () => finish(new Error('Terminal input ended. Key unchanged.'));
    const failed = () => finish(new Error('Could not read terminal input. Key unchanged.'));
    const finish = (error, result) => {
      if (done) return;
      done = true;
      input.removeListener('data', onData);
      input.removeListener('end', closed);
      input.removeListener('close', closed);
      input.removeListener('error', failed);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signals.removeListener(signal, cancelled);
      input.pause();
      try { input.setRawMode(wasRaw); } catch { error ||= new Error('Could not restore terminal input. Key unchanged.'); }
      value = '';
      output.write('\n');
      if (error) reject(error); else resolveKey(result);
    };
    const onData = chunk => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (const char of text) {
        if (char === '\r' || char === '\n') return finish(null, value);
        if (char === '\x03' || char === '\x1b' || char === '\x1a') return cancelled();
        if (char === '\x04') return closed();
        if (char === '\x7f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char === '\x15') value = '';
        else if (/[\x00-\x1f]/.test(char) || value.length >= 65_536) return failed();
        else value += char;
      }
    };
    input.on('data', onData);
    input.once('end', closed);
    input.once('close', closed);
    input.once('error', failed);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signals.on(signal, cancelled);
    try {
      input.setRawMode(true);
      output.write('TypeSafe API key (hidden; Enter skips): ');
      input.resume();
    } catch { failed(); }
  });
}

async function main() {
  if (process.argv.length !== 2) {
    console.error('Usage: node install/key.mjs');
    process.exitCode = 2;
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 20) {
    console.error('Node.js 20 or newer is required.');
    process.exitCode = 1;
    return;
  }
  try {
    const value = await readPrivateKey();
    if (!value) {
      console.log('Key unchanged.');
      return;
    }
    try { savePrivateKey(value); }
    catch { throw new Error('Could not save API key privately. Check file permissions and use a single literal key without spaces, quotes, or shell syntax.'); }
    console.log('API key saved privately. No API request was made.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
