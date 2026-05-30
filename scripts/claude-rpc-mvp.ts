#!/usr/bin/env -S npx tsx
// Minimal "remote-manual" wrapper MVP.
//
// Spawns the interactive `claude` CLI in stream-json mode, reads lines of
// user input from stdin, frames them as `user` messages, and prints every
// stdout JSON event from the CLI back to our stdout as pretty-printed JSON.
//
// Goal: prove that a human-in-the-loop RPC interface over the interactive
// CLI is viable without going through `-p` headless or the SDK.
//
// Usage:
//   pnpm tsx scripts/claude-rpc-mvp.ts
//   > hello, who are you?
//   <stream of JSON events>
//   > /quit            (or Ctrl-D)

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const SESSION_ID = randomUUID();

const child = spawn(
  'claude',
  [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '-p', '',
    '--replay-user-messages',
  ],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);

child.on('exit', (code, signal) => {
  process.stderr.write(`\n[claude exited code=${code} signal=${signal}]\n`);
  process.exit(code ?? 0);
});

// CLI stdout → parse line-delimited JSON → emit framed events.
const cliOut = createInterface({ input: child.stdout!, crlfDelay: Infinity });
cliOut.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    process.stdout.write(JSON.stringify({ kind: 'raw', line: trimmed }) + '\n');
    return;
  }
  // Filter our own echoed user messages so the transcript doesn't double up.
  if (
    typeof parsed === 'object' && parsed !== null &&
    (parsed as { type?: string }).type === 'user' &&
    (parsed as { isReplay?: boolean }).isReplay === true
  ) {
    return;
  }
  process.stdout.write(JSON.stringify({ kind: 'event', event: parsed }) + '\n');
});

// User stdin → wrap each line as a `user` message frame for the CLI.
const userIn = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stderr.write('> ');
userIn.on('line', (raw) => {
  const text = raw.trim();
  if (!text) { process.stderr.write('> '); return; }
  if (text === '/quit' || text === '/exit') {
    child.stdin!.end();
    return;
  }
  const frame = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
  };
  child.stdin!.write(JSON.stringify(frame) + '\n');
  process.stderr.write('> ');
});

userIn.on('close', () => child.stdin!.end());
