// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AgentId,
  ClaudeSessionSummary,
  ContextUsageBreakdown,
  SessionUpdatePayload,
} from '@sumicom/quicksave-shared';
import { applySessionUpdate } from './applySessionUpdate';
import { useClaudeStore } from '../stores/claudeStore';

// ── Mock the zustand store module. Each test rewrites getState()'s return. ──
vi.mock('../stores/claudeStore', () => ({
  useClaudeStore: { getState: vi.fn() },
}));

const getStateMock = useClaudeStore.getState as unknown as ReturnType<typeof vi.fn>;

// ── Helpers ──

function makePayload(overrides: Partial<SessionUpdatePayload> = {}): SessionUpdatePayload {
  return {
    sessionId: 's1',
    isActive: true,
    archived: false,
    isStreaming: false,
    hasPendingInput: false,
    agent: 'claude-code' as AgentId,
    permissionMode: 'default',
    lastPromptAt: 1_000,
    lastTurnEndedAt: 1_500,
    lastCacheTouchAt: 1_700,
    turnCount: 2,
    totalInputTokens: 100,
    totalOutputTokens: 200,
    totalCostUsd: 0.5,
    lastTurnInputTokens: 10,
    lastTurnCacheCreationTokens: 20,
    lastTurnCacheReadTokens: 30,
    lastTurnContextUsage: undefined,
    ...overrides,
  };
}

const MACHINE_AGENT_ID = 'machine-a';

function makeSummary(
  overrides: Partial<ClaudeSessionSummary & { machineAgentId?: string }> = {}
): ClaudeSessionSummary & { machineAgentId?: string } {
  // Build a summary that deep-matches makePayload() by default, so idempotency
  // comparisons hold unless a test explicitly overrides a compared field.
  return {
    sessionId: 's1',
    machineAgentId: MACHINE_AGENT_ID,
    summary: 'summary',
    lastModified: 12345,
    isActive: true,
    archived: false,
    isStreaming: false,
    hasPendingInput: false,
    agent: 'claude-code' as AgentId,
    permissionMode: 'default',
    lastPromptAt: 1_000,
    lastTurnEndedAt: 1_500,
    lastCacheTouchAt: 1_700,
    turnCount: 2,
    totalInputTokens: 100,
    totalOutputTokens: 200,
    totalCostUsd: 0.5,
    lastTurnInputTokens: 10,
    lastTurnCacheCreationTokens: 20,
    lastTurnCacheReadTokens: 30,
    lastTurnContextUsage: undefined,
    ...overrides,
  };
}

interface StoreStub {
  sessions: Record<string, ClaudeSessionSummary & { machineAgentId?: string }>;
  activeSessionId: string | null;
  upsertSession: ReturnType<typeof vi.fn>;
  setActiveSession: ReturnType<typeof vi.fn>;
}

function setupStore(overrides: Partial<StoreStub> = {}): StoreStub {
  const stub: StoreStub = {
    sessions: {},
    activeSessionId: null,
    upsertSession: vi.fn(),
    setActiveSession: vi.fn(),
    ...overrides,
  };
  getStateMock.mockReturnValue(stub);
  return stub;
}

// ── Tests ──

describe('applySessionUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('first delivery / upsert mapping', () => {
    it('calls upsertSession with the fully-mapped payload when no existing session', () => {
      const context: ContextUsageBreakdown = {
        categories: [],
        totalTokens: 1,
        maxTokens: 100,
        percentage: 1,
        capturedAt: 42,
      };
      const store = setupStore();
      const payload = makePayload({ lastTurnContextUsage: context });

      applySessionUpdate(payload, MACHINE_AGENT_ID);

      expect(store.upsertSession).toHaveBeenCalledTimes(1);
      expect(store.upsertSession).toHaveBeenCalledWith({
        sessionId: payload.sessionId,
        machineAgentId: MACHINE_AGENT_ID,
        isActive: payload.isActive,
        archived: payload.archived,
        isStreaming: payload.isStreaming,
        hasPendingInput: payload.hasPendingInput,
        agent: payload.agent,
        permissionMode: payload.permissionMode,
        lastPromptAt: payload.lastPromptAt,
        lastTurnEndedAt: payload.lastTurnEndedAt,
        lastCacheTouchAt: payload.lastCacheTouchAt,
        turnCount: payload.turnCount,
        totalInputTokens: payload.totalInputTokens,
        totalOutputTokens: payload.totalOutputTokens,
        totalCostUsd: payload.totalCostUsd,
        lastTurnInputTokens: payload.lastTurnInputTokens,
        lastTurnCacheCreationTokens: payload.lastTurnCacheCreationTokens,
        lastTurnCacheReadTokens: payload.lastTurnCacheReadTokens,
        lastTurnContextUsage: context,
        lastReadAt: payload.lastReadAt,
        pendingMission: payload.pendingMission,
        queueState: null,
      });
    });

    it('does NOT forward the sandboxed field even if present on the payload', () => {
      const store = setupStore();
      const payload = makePayload({ sandboxed: true });

      applySessionUpdate(payload, MACHINE_AGENT_ID);

      expect(store.upsertSession).toHaveBeenCalledTimes(1);
      const arg = store.upsertSession.mock.calls[0][0];
      expect(arg).not.toHaveProperty('sandboxed');
    });

    it('preserves the existing agent when an update omits agent', () => {
      const store = setupStore({
        sessions: { s1: makeSummary({ agent: 'codex' as AgentId }) },
      });
      const payload = makePayload({ agent: undefined, isActive: false });

      applySessionUpdate(payload, MACHINE_AGENT_ID);

      expect(store.upsertSession).toHaveBeenCalledTimes(1);
      expect(store.upsertSession.mock.calls[0][0].agent).toBe('codex');
    });
  });

  describe('idempotency', () => {
    it('skips upsertSession when every compared field already matches', () => {
      const store = setupStore({
        sessions: { s1: makeSummary() },
      });

      applySessionUpdate(makePayload(), MACHINE_AGENT_ID);

      expect(store.upsertSession).not.toHaveBeenCalled();
    });

    // Parametrized: each single-field difference must trigger upsert.
    const diffCases: Array<{
      field: string;
      existing: Partial<ClaudeSessionSummary>;
      incoming: Partial<SessionUpdatePayload>;
    }> = [
      { field: 'isActive', existing: { isActive: true }, incoming: { isActive: false } },
      { field: 'archived', existing: { archived: false }, incoming: { archived: true } },
      { field: 'isStreaming', existing: { isStreaming: false }, incoming: { isStreaming: true } },
      {
        field: 'hasPendingInput',
        existing: { hasPendingInput: false },
        incoming: { hasPendingInput: true },
      },
      {
        field: 'queueState.queuedPromptPreviews',
        existing: {
          queueState: {
            pendingUserMessages: 2,
            latestPromptPreview: 'second',
            queuedPromptPreviews: ['first', 'second'],
            canInterruptCurrentTurn: true,
          },
        },
        incoming: {
          queueState: {
            pendingUserMessages: 2,
            latestPromptPreview: 'second',
            queuedPromptPreviews: ['first', 'changed'],
            canInterruptCurrentTurn: true,
          },
        },
      },
      {
        field: 'agent',
        existing: { agent: 'claude-code' as AgentId },
        incoming: { agent: 'codex' as AgentId },
      },
      {
        field: 'permissionMode',
        existing: { permissionMode: 'default' },
        incoming: { permissionMode: 'acceptEdits' },
      },
      { field: 'lastPromptAt', existing: { lastPromptAt: 1_000 }, incoming: { lastPromptAt: 2_000 } },
      {
        field: 'lastTurnEndedAt',
        existing: { lastTurnEndedAt: 1_500 },
        incoming: { lastTurnEndedAt: 3_000 },
      },
      {
        field: 'lastCacheTouchAt',
        existing: { lastCacheTouchAt: 1_700 },
        incoming: { lastCacheTouchAt: 4_000 },
      },
      { field: 'turnCount', existing: { turnCount: 2 }, incoming: { turnCount: 3 } },
      {
        field: 'totalInputTokens',
        existing: { totalInputTokens: 100 },
        incoming: { totalInputTokens: 101 },
      },
      {
        field: 'totalOutputTokens',
        existing: { totalOutputTokens: 200 },
        incoming: { totalOutputTokens: 201 },
      },
      { field: 'totalCostUsd', existing: { totalCostUsd: 0.5 }, incoming: { totalCostUsd: 0.6 } },
      {
        field: 'lastTurnInputTokens',
        existing: { lastTurnInputTokens: 10 },
        incoming: { lastTurnInputTokens: 11 },
      },
      {
        field: 'lastTurnCacheCreationTokens',
        existing: { lastTurnCacheCreationTokens: 20 },
        incoming: { lastTurnCacheCreationTokens: 21 },
      },
      {
        field: 'lastTurnCacheReadTokens',
        existing: { lastTurnCacheReadTokens: 30 },
        incoming: { lastTurnCacheReadTokens: 31 },
      },
    ];

    it.each(diffCases)(
      'triggers upsert when $field differs from existing summary',
      ({ existing, incoming }) => {
        const store = setupStore({
          sessions: { s1: makeSummary(existing) },
        });

        applySessionUpdate(makePayload(incoming), MACHINE_AGENT_ID);

        expect(store.upsertSession).toHaveBeenCalledTimes(1);
      }
    );
  });

  describe('lastTurnContextUsage.capturedAt comparison', () => {
    // The code uses optional-chaining on both sides, so the comparison is on
    // `capturedAt` with undefined being a valid sentinel.

    it('skips upsert when both sides have no lastTurnContextUsage (both undefined)', () => {
      const store = setupStore({
        sessions: { s1: makeSummary({ lastTurnContextUsage: undefined }) },
      });

      applySessionUpdate(makePayload({ lastTurnContextUsage: undefined }), MACHINE_AGENT_ID);

      expect(store.upsertSession).not.toHaveBeenCalled();
    });

    it('upserts when existing has capturedAt but payload does not', () => {
      const existingCtx: ContextUsageBreakdown = {
        categories: [],
        totalTokens: 0,
        maxTokens: 0,
        percentage: 0,
        capturedAt: 100,
      };
      const store = setupStore({
        sessions: { s1: makeSummary({ lastTurnContextUsage: existingCtx }) },
      });

      applySessionUpdate(makePayload({ lastTurnContextUsage: undefined }), MACHINE_AGENT_ID);

      expect(store.upsertSession).toHaveBeenCalledTimes(1);
    });

    it('skips upsert when both sides have lastTurnContextUsage with the same capturedAt', () => {
      const ctxExisting: ContextUsageBreakdown = {
        categories: [],
        totalTokens: 1,
        maxTokens: 100,
        percentage: 1,
        capturedAt: 500,
      };
      const ctxIncoming: ContextUsageBreakdown = {
        // Different other fields — only capturedAt is compared for idempotency.
        categories: [{ name: 'cat', tokens: 7, color: '#fff' }],
        totalTokens: 999,
        maxTokens: 2000,
        percentage: 50,
        capturedAt: 500,
      };
      const store = setupStore({
        sessions: { s1: makeSummary({ lastTurnContextUsage: ctxExisting }) },
      });

      applySessionUpdate(makePayload({ lastTurnContextUsage: ctxIncoming }), MACHINE_AGENT_ID);

      expect(store.upsertSession).not.toHaveBeenCalled();
    });

    it('upserts when capturedAt differs between sides', () => {
      const ctxExisting: ContextUsageBreakdown = {
        categories: [],
        totalTokens: 0,
        maxTokens: 0,
        percentage: 0,
        capturedAt: 500,
      };
      const ctxIncoming: ContextUsageBreakdown = {
        categories: [],
        totalTokens: 0,
        maxTokens: 0,
        percentage: 0,
        capturedAt: 600,
      };
      const store = setupStore({
        sessions: { s1: makeSummary({ lastTurnContextUsage: ctxExisting }) },
      });

      applySessionUpdate(makePayload({ lastTurnContextUsage: ctxIncoming }), MACHINE_AGENT_ID);

      expect(store.upsertSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('queueState optimistic replacement', () => {
    it('replaces optimistic queue state with authoritative payload even when visible fields match', () => {
      const authoritativeQueueState = {
        pendingUserMessages: 1,
        latestPromptPreview: 'queued prompt',
        canInterruptCurrentTurn: true,
      };
      const store = setupStore({
        sessions: {
          s1: makeSummary({
            isStreaming: true,
            queueState: {
              ...authoritativeQueueState,
              optimisticUntil: Date.now() + 10_000,
            },
          }),
        },
      });

      applySessionUpdate(
        makePayload({
          isStreaming: true,
          queueState: authoritativeQueueState,
        }),
        MACHINE_AGENT_ID
      );

      expect(store.upsertSession).toHaveBeenCalledTimes(1);
      expect(store.upsertSession.mock.calls[0][0].queueState).toEqual(authoritativeQueueState);
    });

    it('keeps a fresh optimistic queue state when a null streaming payload arrives first', () => {
      const optimisticQueueState = {
        pendingUserMessages: 1,
        latestPromptPreview: 'queued prompt',
        canInterruptCurrentTurn: true,
        optimisticUntil: Date.now() + 10_000,
      };
      const store = setupStore({
        sessions: {
          s1: makeSummary({
            isStreaming: true,
            queueState: optimisticQueueState,
          }),
        },
      });

      applySessionUpdate(
        makePayload({
          isStreaming: true,
          queueState: null,
        }),
        MACHINE_AGENT_ID
      );

      expect(store.upsertSession).toHaveBeenCalledTimes(1);
      expect(store.upsertSession.mock.calls[0][0].queueState).toEqual(optimisticQueueState);
    });
  });

  describe('active-session side effects', () => {
    it('reprojects the active session without persisted preference setters when sessionId matches activeSessionId', () => {
      const store = setupStore({ activeSessionId: 's1' });

      applySessionUpdate(
        makePayload({
          isStreaming: true,
          agent: 'claude-code' as AgentId,
          permissionMode: 'acceptEdits',
        }),
        MACHINE_AGENT_ID
      );

      expect(store.upsertSession).toHaveBeenCalledTimes(1);
      expect(store.setActiveSession).toHaveBeenCalledTimes(1);
      expect(store.setActiveSession).toHaveBeenCalledWith('s1');
    });

    it('still reprojects the active session when agent is undefined', () => {
      const store = setupStore({ activeSessionId: 's1' });

      applySessionUpdate(
        makePayload({
          isStreaming: false,
          agent: undefined,
          permissionMode: 'default',
        }),
        MACHINE_AGENT_ID
      );

      expect(store.setActiveSession).toHaveBeenCalledTimes(1);
      expect(store.setActiveSession).toHaveBeenCalledWith('s1');
    });

    it('still reprojects the active session when permissionMode is undefined', () => {
      const store = setupStore({ activeSessionId: 's1' });

      applySessionUpdate(
        makePayload({
          isStreaming: true,
          agent: 'claude-code' as AgentId,
          permissionMode: undefined,
        }),
        MACHINE_AGENT_ID
      );

      expect(store.setActiveSession).toHaveBeenCalledTimes(1);
      expect(store.setActiveSession).toHaveBeenCalledWith('s1');
    });

    it('does NOT reproject when sessionId does not match activeSessionId', () => {
      const store = setupStore({ activeSessionId: 'other-session' });

      applySessionUpdate(makePayload({ sessionId: 's1', isStreaming: true }), MACHINE_AGENT_ID);

      expect(store.upsertSession).toHaveBeenCalledTimes(1);
      expect(store.setActiveSession).not.toHaveBeenCalled();
    });

    it('skips active-session side effects when idempotency short-circuits (early return)', () => {
      // Snapshot re-delivery on reconnect must NOT cause a redundant UI refresh.
      const store = setupStore({
        sessions: { s1: makeSummary() },
        activeSessionId: 's1',
      });

      applySessionUpdate(makePayload(), MACHINE_AGENT_ID);

      expect(store.upsertSession).not.toHaveBeenCalled();
      expect(store.setActiveSession).not.toHaveBeenCalled();
    });
  });

  describe('lastReadAt forwarding', () => {
    it('forwards lastReadAt from the payload onto the store on first delivery', () => {
      const store = setupStore();
      applySessionUpdate(makePayload({ lastReadAt: 5_555 }), MACHINE_AGENT_ID);
      const arg = store.upsertSession.mock.calls[0][0];
      expect(arg.lastReadAt).toBe(5_555);
    });

    it('triggers upsert when only lastReadAt differs', () => {
      const store = setupStore({
        sessions: { s1: makeSummary({ lastReadAt: 1_000 }) },
      });
      applySessionUpdate(makePayload({ lastReadAt: 2_000 }), MACHINE_AGENT_ID);
      expect(store.upsertSession).toHaveBeenCalledTimes(1);
      expect(store.upsertSession.mock.calls[0][0].lastReadAt).toBe(2_000);
    });

    it('skips upsert when lastReadAt matches and everything else does too', () => {
      const store = setupStore({
        sessions: { s1: makeSummary({ lastReadAt: 7_777 }) },
      });
      applySessionUpdate(makePayload({ lastReadAt: 7_777 }), MACHINE_AGENT_ID);
      expect(store.upsertSession).not.toHaveBeenCalled();
    });
  });
});
