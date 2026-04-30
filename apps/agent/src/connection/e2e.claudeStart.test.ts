// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { simpleGit } from 'simple-git';
import type {
  CardEvent,
  CardHistoryResponse,
  SessionCardsUpdate,
  SessionUpdatePayload,
} from '@sumicom/quicksave-shared';
import {
  FakeRelayHub,
  FakeWebSocket,
  setActiveFakeRelayHub,
} from './fakeRelay.js';

/**
 * E2E test that drives `claude:start` end-to-end with a `StubProvider`
 * standing in for the real CLI. Verifies the full async chain:
 *
 *   PWA → bus.command('claude:start')
 *     → wireLegacyBusVerbs adapter
 *     → MessageHandler.handleClaudeStart
 *     → SessionManager.startSession
 *     → StubProvider.startSession (returns synthetic sessionId)
 *     → response back to PWA with sessionId
 *
 * Then card events flow back the other way:
 *
 *   StubProvider.emitCard(...)
 *     → SessionManager 'card-event'
 *     → wireSessionBus → bus.publish('/sessions/:id/cards', { kind: 'card', event })
 *     → PWA's subscription onUpdate
 *
 * This is the exact path that gets stuck if the agent ever "blocks" on a
 * verb — every async hop is real here, so a regression in encryption,
 * gzip, bus dispatch, SessionManager, or the publish wiring would break
 * the test.
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

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    addManagedRepo: vi.fn(),
    removeManagedRepo: vi.fn(),
    addManagedCodingPath: vi.fn(),
    removeManagedCodingPath: vi.fn(),
    getAnthropicApiKey: vi.fn(() => undefined),
    setAnthropicApiKey: vi.fn(),
    hasAnthropicApiKey: vi.fn(() => false),
  };
});

import { setQuicksaveDir } from '../service/singleton.js';
import { createDefaultConfig } from '../config.js';
import { resetSessionRegistry } from '../ai/sessionRegistry.js';
import { resetEventStore } from '../storage/eventStore.js';
import { SessionManager } from '../ai/sessionManager.js';
import { MessageHandler } from '../handlers/messageHandler.js';
import { wireLegacyBusVerbs } from '../handlers/legacyBusAdapter.js';
import {
  buildAgent,
  FakePwa,
  StubProvider,
  wireSessionBus,
  type AgentSide,
} from './e2eHarness.js';

const flush = (ms = 0): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe('claude:start end-to-end with StubProvider', () => {
  let hub: FakeRelayHub;
  let agent: AgentSide;
  let pwa: FakePwa;
  let messageHandler: MessageHandler;
  let stub: StubProvider;
  let sessionManager: SessionManager;
  let tempDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'qs-claude-'));
    setQuicksaveDir(tempDir);
    resetSessionRegistry();
    resetEventStore();
    const config = createDefaultConfig('ws://test');

    repoPath = mkdtempSync(join(tmpdir(), 'qs-claude-repo-'));
    const git = simpleGit(repoPath);
    await git.init();
    await git.addConfig('user.email', 't@t.com');
    await git.addConfig('user.name', 't');
    writeFileSync(join(repoPath, 'README.md'), '# t\n');
    await git.add('README.md');
    await git.commit('initial');

    hub = new FakeRelayHub();
    setActiveFakeRelayHub(hub);

    stub = new StubProvider({ id: 'claude-code' });
    sessionManager = new SessionManager([stub], 'claude-code');

    agent = buildAgent({
      agentId: config.agentId,
      agentKeyPair: config.keyPair,
    });

    messageHandler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { sessionManager },
    );
    wireLegacyBusVerbs(agent.bus, messageHandler);
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
    messageHandler?.cleanup();
    setActiveFakeRelayHub(null);
    hub?.close();
    resetSessionRegistry();
    resetEventStore();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('claude:start spawns a session and responds with sessionId', async () => {
    const result = await pwa.bus().command<unknown, {
      success: boolean;
      sessionId?: string;
      error?: string;
    }>('claude:start', {
      prompt: 'hello world',
      cwd: repoPath,
      agent: 'claude-code',
    });

    expect(result.success).toBe(true);
    expect(result.sessionId).toMatch(/^stub-/);
    // The stub recorded the prompt the SessionManager passed in.
    expect(stub.promptsFor(result.sessionId!)).toContain('hello world');
  });

  it('subscribed PWA receives card snapshot, card update, and stream-end', async () => {
    const startResult = await pwa.bus().command<unknown, {
      success: boolean;
      sessionId?: string;
    }>('claude:start', {
      prompt: 'test prompt',
      cwd: repoPath,
      agent: 'claude-code',
    });
    expect(startResult.success).toBe(true);
    const sessionId = startResult.sessionId!;

    const snapshots: CardHistoryResponse[] = [];
    const updates: SessionCardsUpdate[] = [];
    pwa.bus().subscribe<CardHistoryResponse, SessionCardsUpdate>(
      `/sessions/${sessionId}/cards`,
      {
        onSnapshot: (data) => snapshots.push(data),
        onUpdate: (data) => updates.push(data),
      },
    );

    // Snapshot lands first — empty cards array because the stub hasn't
    // emitted anything yet.
    await flush(20);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].cards).toEqual([]);
    expect(snapshots[0].total).toBe(0);

    // Push an `add` card event from the stub provider.
    const addEvent: CardEvent = {
      type: 'add',
      sessionId,
      card: {
        id: 'card-1',
        type: 'assistant_text',
        text: 'hello back',
        timestamp: Date.now(),
      } as any,
    };
    stub.emitCard(sessionId, addEvent);
    await flush(20);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ kind: 'card', event: addEvent });

    // Append text on top of the existing card.
    const appendEvent: CardEvent = {
      type: 'append_text',
      sessionId,
      cardId: 'card-1',
      text: ', world',
    };
    stub.emitCard(sessionId, appendEvent);
    await flush(20);

    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual({ kind: 'card', event: appendEvent });

    // End of turn.
    stub.finishStream(sessionId, {
      success: true,
      tokenUsage: { input: 4, output: 7 },
      totalCostUsd: 0.0001,
    });
    await flush(20);

    expect(updates).toHaveLength(3);
    expect(updates[2].kind).toBe('stream-end');
    if (updates[2].kind !== 'stream-end') throw new Error('unreachable');
    expect(updates[2].result.success).toBe(true);
    expect(updates[2].result.sessionId).toBe(sessionId);
  });

  it('subscribed PWA gets /sessions/active update when a session starts', async () => {
    const updates: SessionUpdatePayload[] = [];
    pwa.bus().subscribe<SessionUpdatePayload[], SessionUpdatePayload>(
      '/sessions/active',
      {
        onSnapshot: () => { /* ignore initial snapshot */ },
        onUpdate: (data) => updates.push(data),
      },
    );
    await flush(20);

    const startResult = await pwa.bus().command<unknown, {
      success: boolean;
      sessionId?: string;
    }>('claude:start', {
      prompt: 'p',
      cwd: repoPath,
      agent: 'claude-code',
    });

    await flush(20);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const matching = updates.find((u) => u.sessionId === startResult.sessionId);
    expect(matching).toBeDefined();
    expect(matching!.isActive).toBe(true);
  });

  it('claude:cancel routes to the stub session and triggers interrupt', async () => {
    const startResult = await pwa.bus().command<unknown, {
      success: boolean;
      sessionId?: string;
    }>('claude:start', {
      prompt: 'long-running',
      cwd: repoPath,
      agent: 'claude-code',
    });
    const sessionId = startResult.sessionId!;
    expect(stub.wasInterrupted(sessionId)).toBe(false);

    await pwa.bus().command('claude:cancel', {
      sessionId,
    });

    expect(stub.wasInterrupted(sessionId)).toBe(true);
  });

  it('claude:resume re-uses the same sessionId and forwards the new prompt', async () => {
    const start = await pwa.bus().command<unknown, {
      success: boolean;
      sessionId?: string;
    }>('claude:start', {
      prompt: 'first',
      cwd: repoPath,
      agent: 'claude-code',
    });
    const sessionId = start.sessionId!;

    // End the first turn so the session is no longer "streaming". This
    // matches the prod flow where resume happens after an idle.
    stub.finishStream(sessionId, { success: true });
    await flush(20);

    const resume = await pwa.bus().command<unknown, {
      success: boolean;
      sessionId?: string;
    }>('claude:resume', {
      sessionId,
      prompt: 'follow-up',
      cwd: repoPath,
      agent: 'claude-code',
    });
    expect(resume.success).toBe(true);
    expect(resume.sessionId).toBe(sessionId);
    expect(stub.promptsFor(sessionId)).toContain('follow-up');
  });
});
