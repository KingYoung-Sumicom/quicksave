// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Tiny CLI invoked by claude as a hook command. Its job:
 *
 *   1. Read the hook payload (JSON) from stdin.
 *   2. Forward `{event, payload}` to the daemon's Unix socket.
 *   3. Read the `{decision}` line back.
 *   4. If `decision` is non-null, print it on stdout for claude to consume.
 *
 * The event name is taken from `payload.hook_event_name` (claude tags every
 * payload). The socket path is passed as argv[2] so settingsBuilder can
 * generate a one-liner command without baking the path into source.
 *
 * Exit code is always 0 — claude treats a non-zero exit as a hook error and
 * surfaces it in the TUI, which we don't want for transport failures
 * (better to silently lose the structured event than break the user's turn).
 */

import { connect, type Socket } from 'node:net';

const CONNECT_TIMEOUT_MS = 2_000;
const TOTAL_TIMEOUT_MS = 35_000;

async function main(): Promise<void> {
  const socketPath = process.argv[2];
  if (!socketPath) return;

  const payloadText = await readAllStdin();
  if (!payloadText.trim()) return;

  let payload: { hook_event_name?: string; [k: string]: unknown };
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return;
  }
  const event = payload.hook_event_name;
  if (typeof event !== 'string') return;

  const frame = JSON.stringify({ event, payload }) + '\n';

  let resolved = false;
  const result = await new Promise<string | null>((resolve) => {
    const done = (v: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(v);
    };

    let sock: Socket | null = null;
    const overallTimer = setTimeout(() => {
      try { sock?.destroy(); } catch { /* */ }
      done(null);
    }, TOTAL_TIMEOUT_MS);

    try {
      sock = connect(socketPath);
    } catch {
      clearTimeout(overallTimer);
      done(null);
      return;
    }
    const connectTimer = setTimeout(() => {
      try { sock?.destroy(); } catch { /* */ }
      clearTimeout(overallTimer);
      done(null);
    }, CONNECT_TIMEOUT_MS);

    let buf = '';
    sock.on('connect', () => {
      clearTimeout(connectTimer);
      sock!.write(frame);
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        clearTimeout(overallTimer);
        try { sock!.end(); } catch { /* */ }
        done(line);
      }
    });
    sock.on('error', () => {
      clearTimeout(connectTimer);
      clearTimeout(overallTimer);
      done(null);
    });
    sock.on('close', () => {
      clearTimeout(connectTimer);
      clearTimeout(overallTimer);
      done(null);
    });
  });

  if (result == null) return;

  let parsed: { decision?: unknown };
  try { parsed = JSON.parse(result); } catch { return; }

  if (parsed.decision !== null && typeof parsed.decision === 'object') {
    process.stdout.write(JSON.stringify(parsed.decision));
  }
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

main().catch(() => process.exit(0));
