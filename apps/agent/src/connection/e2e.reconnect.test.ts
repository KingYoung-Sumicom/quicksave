// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ClaudePreferences } from '@sumicom/quicksave-shared';
import {
  FakeRelayHub,
  FakeWebSocket,
  setActiveFakeRelayHub,
  type FakeWsSocket,
} from './fakeRelay.js';

/**
 * Reconnect-after-disruption end-to-end test.
 *
 * Scenario the PWA actually hits in the field: the agent's relay socket
 * gets terminated mid-session (relay restart, transient network blip,
 * heartbeat timeout), the PWA stays up the whole time, and once the
 * agent's auto-reconnect succeeds the existing PWA subscriptions need to
 * (1) survive the disruption and (2) deliver a *fresh* snapshot through
 * the new key-exchange.
 *
 * What's exercised here that no other test covers:
 * - `AgentConnection.signaling.on('disconnected')` fires `disconnected`
 *   per peer; the bus server drops every active sub for that peer.
 * - `MessageBusClient.handleDisconnected` rejects in-flight commands and
 *   marks subscriptions wireActive=false.
 * - Auto-reconnect via `SignalingClient.attemptReconnect` (real timer,
 *   driven by `vi.advanceTimersByTimeAsync`).
 * - Hub's `agent-status: online=true` push wakes the PWA, which runs a
 *   second V2 key-exchange with a *fresh* DEK.
 * - `MessageBusClient.handleConnected` re-sends the `sub` frame; the bus
 *   server replays the snapshot atomically so the PWA reflects whatever
 *   state-mutation happened during the disconnect window.
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
import { createDefaultConfig } from '../config.js';
import { resetSessionRegistry } from '../ai/sessionRegistry.js';
import { resetEventStore } from '../storage/eventStore.js';
import { SessionManager } from '../ai/sessionManager.js';
import {
  buildAgent,
  FakePwa,
  StubProvider,
  wireSessionBus,
  type AgentSide,
} from './e2eHarness.js';

const flush = (ms = 0): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe('reconnect after agent socket disruption', () => {
  let hub: FakeRelayHub;
  let agent: AgentSide;
  let pwa: FakePwa;
  let sessionManager: SessionManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'qs-reconnect-'));
    setQuicksaveDir(tempDir);
    resetSessionRegistry();
    resetEventStore();
    const config = createDefaultConfig('ws://test');

    hub = new FakeRelayHub();
    setActiveFakeRelayHub(hub);

    sessionManager = new SessionManager([new StubProvider()], 'claude-code');

    agent = buildAgent({
      agentId: config.agentId,
      agentKeyPair: config.keyPair,
    });
    wireSessionBus(agent.bus, sessionManager);

    await agent.start();
    pwa = new FakePwa({
      hub,
      agentId: agent.agentId,
      agentPublicKeyB64: agent.publicKeyB64,
    });
    await pwa.start();
  });

  afterEach(async () => {
    pwa?.close();
    agent?.stop();
    setActiveFakeRelayHub(null);
    hub?.close();
    resetSessionRegistry();
    resetEventStore();
    vi.useRealTimers();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * Drive AgentConnection's reconnect setTimeout (1s base + up to 5s jitter)
   * to completion deterministically. Real timers would make the suite slow;
   * fake timers also let us assert that no other state changes leak into
   * the disconnect window.
   */
  async function driveReconnect(): Promise<void> {
    // Fake timers must already be active before the close fires so the
    // reconnect's setTimeout lands on the fake queue. Caller is responsible.
    // 6.5s clears the maximum 1s+5s base+jitter with margin.
    await vi.advanceTimersByTimeAsync(6500);
  }

  function findAgentSocket(): FakeWsSocket {
    const peer = hub
      .listPeers()
      .find((p) => p.channel === 'agent' && p.id === agent.agentId);
    if (!peer) throw new Error('agent not attached to hub');
    return peer.socket;
  }

  it('subscription survives a hub-induced agent socket close and replays snapshot', async () => {
    const snapshots: ClaudePreferences[] = [];
    const updates: ClaudePreferences[] = [];
    pwa.bus().subscribe<ClaudePreferences, ClaudePreferences>(
      '/preferences',
      {
        onSnapshot: (data) => snapshots.push(data),
        onUpdate: (data) => updates.push(data),
      },
    );
    await flush(20);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].model).toBe('claude-opus-4-7');

    // Switch to fake timers BEFORE closing so the reconnect setTimeout
    // queues onto the fake clock (real timers would make this test slow
    // and racy with vitest's 5s default test timeout).
    vi.useFakeTimers();
    findAgentSocket().terminate();
    // Microtask-only event chain: hub close → AgentConnection 'disconnected'
    // → bus server drops subs → FakePwa sees `agent-status: online=false`
    // → bus transport disconnected. Drain microtasks via a 0ms tick.
    await vi.advanceTimersByTimeAsync(0);

    // While disconnected, mutate the preference. The bus server's snapshot
    // function reads `sessionManager.getPreferences()`, so the *next*
    // wire-level sub will deliver the new value. The publish that
    // `setPreferences` triggers is also fired but lands on the now-empty
    // sub set — verifying that the reconnect path goes through snapshot,
    // not through a leaked update from the prior peer state.
    sessionManager.setPreferences({ model: 'mid-disconnect-model' });

    // Drive AgentConnection's reconnect setTimeout (1s + up to 5s jitter).
    await driveReconnect();
    // Drain any trailing microtasks from the new key-exchange round-trip.
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    // One more real-timer flush to let the bus client's onConnected
    // re-sub frames + snapshot delivery complete.
    await flush(50);

    // Snapshot should have been delivered again with the new value.
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    const lastSnap = snapshots[snapshots.length - 1];
    expect(lastSnap.model).toBe('mid-disconnect-model');
  });

  it('in-flight commands are rejected when the agent socket goes down', async () => {
    // Stall the bus server's adapter on a custom verb so the command stays
    // in-flight long enough for us to terminate the agent.
    let resolveServer: (value: unknown) => void = () => {};
    const serverHandlerStarted = new Promise<void>((startResolve) => {
      agent.bus.onCommand('slow-verb', () => {
        startResolve();
        return new Promise((r) => {
          resolveServer = r;
        });
      });
    });

    const inFlight = pwa.bus().command('slow-verb', {});
    // Attach the rejection assertion BEFORE causing the rejection. The bus
    // client rejects synchronously inside `handleDisconnected`, so an
    // assertion attached later would surface as an unhandled rejection
    // (vitest's PromiseRejectionHandledWarning) even though the test
    // itself succeeds.
    const inFlightAssertion = expect(inFlight).rejects.toThrow(
      /Transport disconnected/,
    );
    await serverHandlerStarted;

    // Terminate the agent socket while the command is in flight.
    vi.useFakeTimers();
    findAgentSocket().terminate();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await flush(20);

    // The bus client's `handleDisconnected` should reject the pending
    // promise rather than letting it hang until timeout.
    await inFlightAssertion;

    // Cleanup: resolve the dangling server handler so it doesn't keep
    // pending past the test (the result frame just gets dropped on the
    // closed transport).
    resolveServer({ ok: true });
  });

  it('subscriptions issued AFTER reconnect work normally with the new DEK', async () => {
    vi.useFakeTimers();
    findAgentSocket().terminate();
    await vi.advanceTimersByTimeAsync(0);
    await driveReconnect();
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    await flush(50);

    // Issue a fresh subscribe AFTER reconnect — this exercises the new
    // DEK end-to-end through encrypt+gzip+routed-envelope+decrypt.
    const snapshots: ClaudePreferences[] = [];
    pwa.bus().subscribe<ClaudePreferences, ClaudePreferences>(
      '/preferences',
      {
        onSnapshot: (data) => snapshots.push(data),
        onUpdate: () => {},
      },
    );
    await flush(20);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].model).toBe('claude-opus-4-7');
  });
});
