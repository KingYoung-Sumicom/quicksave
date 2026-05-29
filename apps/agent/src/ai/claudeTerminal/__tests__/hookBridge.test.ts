// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from 'vitest';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HookBridge, type HookRequest } from '../hookBridge.js';

const sockPath = () => join(tmpdir(), `qs-hook-test-${randomBytes(4).toString('hex')}.sock`);

async function sendFrame(socketPath: string, frame: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    sock.on('connect', () => sock.write(JSON.stringify(frame) + '\n'));
    sock.on('data', (c) => { buf += c.toString('utf8'); });
    sock.on('close', () => resolve(buf));
    sock.on('error', reject);
    setTimeout(() => { try { sock.destroy(); } catch { /* */ } reject(new Error('timeout')); }, 5000);
  });
}

describe('HookBridge', () => {
  let bridge: HookBridge | null = null;

  afterEach(async () => {
    await bridge?.stop();
    bridge = null;
  });

  it('emits a request event with parsed payload', async () => {
    bridge = new HookBridge(sockPath());
    await bridge.start();

    const seen: HookRequest[] = [];
    bridge.onRequest((req) => {
      seen.push(req);
      req.respond(null);
    });

    await sendFrame(bridge.socketPath, {
      event: 'Stop',
      payload: { hook_event_name: 'Stop', session_id: 'sid', transcript_path: '/tmp/t.jsonl' },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].event).toBe('Stop');
    expect(seen[0].payload.session_id).toBe('sid');
  });

  it('returns the decision the listener provides', async () => {
    bridge = new HookBridge(sockPath());
    await bridge.start();

    bridge.onRequest((req) => {
      req.respond({
        hookSpecificOutput: {
          hookEventName: req.event,
          decision: { behavior: 'deny', message: 'no thanks' },
        },
      });
    });

    const responseLine = await sendFrame(bridge.socketPath, {
      event: 'PermissionRequest',
      payload: { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
    });
    const parsed = JSON.parse(responseLine.trim().split('\n')[0]);
    expect(parsed.decision.hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('auto-acks with null when no listener is registered', async () => {
    bridge = new HookBridge(sockPath());
    await bridge.start();
    const responseLine = await sendFrame(bridge.socketPath, {
      event: 'Stop',
      payload: { hook_event_name: 'Stop' },
    });
    const parsed = JSON.parse(responseLine.trim().split('\n')[0]);
    expect(parsed.decision).toBeNull();
  });

  it('ignores garbage input and auto-acks', async () => {
    bridge = new HookBridge(sockPath());
    await bridge.start();
    const responseLine = await sendFrame(bridge.socketPath, { not: 'a hook frame' } as object);
    const parsed = JSON.parse(responseLine.trim().split('\n')[0]);
    expect(parsed.decision).toBeNull();
  });
});
