// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  FakeRelayHub,
  FakeWebSocket,
  setActiveFakeRelayHub,
} from './fakeRelay.js';

/**
 * End-to-end test driving real production code on the agent side
 * (`SignalingClient` → `AgentConnection` → `BusServerTransport` →
 * `MessageBusServer`) over a `FakeRelayHub`, with a `FakePwa` standing
 * in for the browser tab that runs real V2 key-exchange and sends real
 * `bus:frame` envelopes through the encrypted channel.
 *
 * The crypto, gzip, base64 framing, routing envelope, and bus dispatch
 * are all real. Only the WebSocket layer and the tombstone HTTP catch-up
 * are mocked.
 */

vi.mock('ws', () => ({
  __esModule: true,
  default: FakeWebSocket,
  WebSocket: FakeWebSocket,
}));

vi.mock('../tombstoneCheck.js', () => ({
  checkTombstone: vi.fn().mockResolvedValue({ status: 'absent' }),
  hashPublicKey: vi.fn((pk: string) => `hash-${pk.slice(0, 12)}`),
  verifyTombstonePayload: vi.fn(),
}));

import { setQuicksaveDir } from '../service/singleton.js';
import { createDefaultConfig, loadConfig, isPaired } from '../config.js';
import { buildAgent, FakePwa, type AgentSide } from './e2eHarness.js';

const flush = (ms = 0): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe('agent ↔ FakeRelayHub ↔ FakePwa over message bus', () => {
  let hub: FakeRelayHub;
  let agent: AgentSide;
  let pwa: FakePwa;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'qs-e2e-'));
    setQuicksaveDir(tempDir);
    // Real config on disk so the production AgentConnection can isPaired()
    // and pinPeerPWA() against it. signalingServer is unused in tests but
    // must be present.
    const config = createDefaultConfig('ws://test');

    hub = new FakeRelayHub();
    setActiveFakeRelayHub(hub);

    agent = buildAgent({
      agentId: config.agentId,
      agentKeyPair: config.keyPair,
    });
  });

  afterEach(() => {
    pwa?.close();
    agent?.stop();
    setActiveFakeRelayHub(null);
    hub?.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('completes V2 key exchange when the PWA connects', async () => {
    await agent.start();
    expect(hub.peerCount()).toBe(1);

    pwa = new FakePwa({
      hub,
      agentId: agent.agentId,
      agentPublicKeyB64: agent.publicKeyB64,
    });

    let connectedPeer: string | null = null;
    agent.connection.on('connected', (peer: string) => {
      connectedPeer = peer;
    });

    await pwa.start();

    expect(connectedPeer).toContain('pwa:');
    // TOFU should have pinned the PWA's signing pubkey on disk.
    const after = loadConfig();
    expect(isPaired(after!)).toBe(true);
    expect(after!.peerPWASignPublicKey).toBe(pwa.signingPublicKeyB64());
  });

  it('PWA bus.command() dispatches to a registered handler and returns the result', async () => {
    await agent.start();
    pwa = new FakePwa({
      hub,
      agentId: agent.agentId,
      agentPublicKeyB64: agent.publicKeyB64,
    });

    agent.bus.onCommand<{ a: number; b: number }, { sum: number }>(
      'add',
      (payload) => ({ sum: payload.a + payload.b }),
    );

    await pwa.start();

    const result = await pwa.bus().command<
      { a: number; b: number },
      { sum: number }
    >('add', { a: 7, b: 35 });

    expect(result).toEqual({ sum: 42 });
  });

  it('rejects with an error when the verb is not registered', async () => {
    await agent.start();
    pwa = new FakePwa({
      hub,
      agentId: agent.agentId,
      agentPublicKeyB64: agent.publicKeyB64,
    });
    await pwa.start();

    await expect(
      pwa.bus().command('does-not-exist', {}),
    ).rejects.toThrow(/Unknown command: does-not-exist/);
  });

  it('subscribe + publish delivers snapshot then update', async () => {
    await agent.start();
    pwa = new FakePwa({
      hub,
      agentId: agent.agentId,
      agentPublicKeyB64: agent.publicKeyB64,
    });

    let snapshotValue = 0;
    agent.bus.onSubscribe('counter', {
      snapshot: () => snapshotValue,
    });

    await pwa.start();

    const snapshots: number[] = [];
    const updates: number[] = [];
    pwa.bus().subscribe<number, number>('counter', {
      onSnapshot: (data) => snapshots.push(data),
      onUpdate: (data) => updates.push(data),
    });

    // Wait for the snapshot frame to land.
    await flush(20);
    expect(snapshots).toEqual([0]);

    snapshotValue = 1;
    agent.bus.publish('counter', 1);
    await flush(20);
    expect(updates).toEqual([1]);

    snapshotValue = 2;
    agent.bus.publish('counter', 2);
    await flush(20);
    expect(updates).toEqual([1, 2]);
  });

  it('handler errors surface as command rejections with the error message', async () => {
    await agent.start();
    pwa = new FakePwa({
      hub,
      agentId: agent.agentId,
      agentPublicKeyB64: agent.publicKeyB64,
    });

    agent.bus.onCommand('boom', () => {
      throw new Error('something went wrong');
    });

    await pwa.start();

    await expect(pwa.bus().command('boom', {})).rejects.toThrow(
      /something went wrong/,
    );
  });

  it('multiple commands in flight resolve in order', async () => {
    await agent.start();
    pwa = new FakePwa({
      hub,
      agentId: agent.agentId,
      agentPublicKeyB64: agent.publicKeyB64,
    });

    const completionLog: number[] = [];
    agent.bus.onCommand<{ n: number }, { n: number }>('echo-async', async (p) => {
      // Simulate a tiny async hop on the agent side.
      await flush(0);
      return { n: p.n };
    });

    await pwa.start();

    const results = await Promise.all([
      pwa.bus().command<{ n: number }, { n: number }>('echo-async', { n: 1 }),
      pwa.bus().command<{ n: number }, { n: number }>('echo-async', { n: 2 }),
      pwa.bus().command<{ n: number }, { n: number }>('echo-async', { n: 3 }),
    ]);
    completionLog.push(...results.map((r) => r.n));

    expect(results).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(completionLog).toEqual([1, 2, 3]);
  });
});
