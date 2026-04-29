import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionManager, type ManagedSession } from './sessionManager.js';
import { StreamCardBuilder } from './cardBuilder.js';
import { setQuicksaveDir } from '../service/singleton.js';
import type {
  CodingAgentProvider,
  ProviderSession,
  ProviderCallbacks,
  PermissionLevel,
} from './provider.js';

// ── Mocks ──

vi.mock('./cardBuilder.js', () => {
  const StreamCardBuilder = vi.fn().mockImplementation((sessionId: string, cwd: string) => ({
    sessionId,
    cwd,
    jsonlCutoff: null,
    updateSessionId: vi.fn(),
    snapshotCutoff: vi.fn().mockResolvedValue(undefined),
    getCards: vi.fn().mockReturnValue([]),
    userMessage: vi.fn().mockReturnValue({ type: 'add', card: { type: 'user', id: 'u1', text: 'hi' } }),
    clearPendingInput: vi.fn().mockReturnValue(null),
    toolCallFromPermission: vi.fn().mockReturnValue({
      type: 'add',
      card: { type: 'tool_call', id: 'tc1', toolName: 'Bash', toolUseId: 'tu1' },
    }),
    startNewTurn: vi.fn(),
  }));
  return {
    StreamCardBuilder,
    buildCardsFromHistory: vi.fn().mockResolvedValue({ cards: [], total: 0, hasMore: false }),
    loadPersistedCards: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('./sessionRegistry.js', () => ({
  getSessionRegistry: vi.fn().mockReturnValue({
    getEntry: vi.fn().mockReturnValue(null),
    getEntriesForProject: vi.fn().mockReturnValue([]),
    findBySessionId: vi.fn().mockReturnValue(undefined),
    upsertEntry: vi.fn(),
    updateEntry: vi.fn(),
  }),
}));

vi.mock('./sandboxMcp.js', () => ({
  SANDBOX_MCP_NAME: 'quicksave-sandbox',
  SANDBOX_MCP_PREFIX: 'mcp__quicksave-sandbox__',
  SANDBOX_BASH_TOOL: 'mcp__quicksave-sandbox__SandboxBash',
  UPDATE_SESSION_STATUS_TOOL: 'mcp__quicksave-sandbox__UpdateSessionStatus',
}));

// ── Helpers ──

function createMockProviderSession(overrides?: Partial<ProviderSession>): ProviderSession {
  return {
    sendUserMessage: vi.fn(),
    interrupt: vi.fn(),
    kill: vi.fn(),
    alive: true,
    ...overrides,
  };
}

function createMockProvider(
  id: string = 'claude-code',
  historyMode: 'claude-jsonl' | 'memory' = 'claude-jsonl',
): CodingAgentProvider {
  const mockSession = createMockProviderSession();
  return {
    id: id as any,
    historyMode,
    startSession: vi.fn().mockResolvedValue({
      sessionId: `session-${Date.now()}`,
      session: mockSession,
    }),
    resumeSession: vi.fn().mockResolvedValue({
      sessionId: `session-${Date.now()}`,
      session: mockSession,
    }),
  };
}

// ── Edge Case Tests ──

describe('SessionManager — adversarial edge cases', () => {
  let manager: SessionManager;
  let provider: CodingAgentProvider;
  let tmpQuicksaveDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpQuicksaveDir = mkdtempSync(join(tmpdir(), 'qs-session-edge-test-'));
    setQuicksaveDir(tmpQuicksaveDir);
    provider = createMockProvider();
    manager = new SessionManager([provider]);
  });

  afterEach(() => {
    try {
      rmSync(tmpQuicksaveDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // ── 1. Concurrent session starts ──

  describe('concurrent startSession calls', () => {
    it('two startSession calls with different session IDs should both succeed independently', async () => {
      let callCount = 0;
      (provider.startSession as Mock).mockImplementation(async () => {
        callCount++;
        return {
          sessionId: `session-${callCount}`,
          session: createMockProviderSession(),
        };
      });

      const [id1, id2] = await Promise.all([
        manager.startSession({ prompt: 'A', cwd: '/tmp/a' }),
        manager.startSession({ prompt: 'B', cwd: '/tmp/b' }),
      ]);

      expect(id1).not.toBe(id2);
      expect(manager.getActiveSessions()).toHaveLength(2);
      expect(manager.isStreaming(id1)).toBe(true);
      expect(manager.isStreaming(id2)).toBe(true);
    });

    it('two startSession calls returning the SAME sessionId should overwrite — last writer wins', async () => {
      // This is a pathological scenario: provider returns the same sessionId for two starts
      const sharedSession1 = createMockProviderSession();
      const sharedSession2 = createMockProviderSession();
      let callCount = 0;
      (provider.startSession as Mock).mockImplementation(async () => {
        callCount++;
        return {
          sessionId: 'duplicate-id',
          session: callCount === 1 ? sharedSession1 : sharedSession2,
        };
      });

      const [id1, id2] = await Promise.all([
        manager.startSession({ prompt: 'A', cwd: '/tmp/a' }),
        manager.startSession({ prompt: 'B', cwd: '/tmp/b' }),
      ]);

      expect(id1).toBe(id2);
      // Only one entry in sessions map — the second write wins
      expect(manager.getActiveSessions()).toHaveLength(1);
      // BUG: The first session's providerSession is silently replaced without calling kill().
      // The first providerSession is orphaned — never killed.
      expect(sharedSession1.kill).not.toHaveBeenCalled();
    });

    it('concurrent starts with same cwd should create separate sessions', async () => {
      let callCount = 0;
      (provider.startSession as Mock).mockImplementation(async () => ({
        sessionId: `concurrent-${++callCount}`,
        session: createMockProviderSession(),
      }));

      const [id1, id2] = await Promise.all([
        manager.startSession({ prompt: 'A', cwd: '/tmp/same' }),
        manager.startSession({ prompt: 'B', cwd: '/tmp/same' }),
      ]);

      expect(id1).not.toBe(id2);
      expect(manager.getSessionCwd(id1)).toBe('/tmp/same');
      expect(manager.getSessionCwd(id2)).toBe('/tmp/same');
    });
  });

  // ── 2. Resume during streaming (hot resume) ──

  describe('resumeSession during active streaming (hot resume)', () => {
    it('hot resume delegates user prompt persistence to the provider session', async () => {
      const sessionId = 'hot-resume';
      const mockProvSession = createMockProviderSession({ alive: true });
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: mockProvSession,
      });

      await manager.startSession({ prompt: 'Start', cwd: '/tmp/test' });
      const cardBuilder = (StreamCardBuilder as unknown as Mock).mock.results[0].value;
      cardBuilder.userMessage.mockClear();
      cardBuilder.startNewTurn.mockClear();

      const result = await manager.resumeSession({
        sessionId,
        prompt: 'Follow-up',
        cwd: '/tmp/test',
              });

      expect(result).toBe(sessionId);
      expect(mockProvSession.sendUserMessage).toHaveBeenCalledWith('Follow-up');
      expect(cardBuilder.userMessage).not.toHaveBeenCalled();
      expect(cardBuilder.startNewTurn).not.toHaveBeenCalled();
    });

    it('hot resume on a session where streaming=true but alive=false should fall to cold resume', async () => {
      const sessionId = 'hot-dead';
      const deadSession = createMockProviderSession({ alive: false });
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: deadSession,
      });

      await manager.startSession({ prompt: 'Start', cwd: '/tmp/test' });

      // Provider is dead but streaming flag is still true — should NOT hot resume
      const coldSession = createMockProviderSession();
      (provider.resumeSession as Mock).mockResolvedValue({
        sessionId,
        session: coldSession,
      });

      await manager.resumeSession({
        sessionId,
        prompt: 'Follow-up',
        cwd: '/tmp/test',
              });

      // Should have gone through cold resume path
      expect(provider.resumeSession).toHaveBeenCalled();
      expect(deadSession.sendUserMessage).not.toHaveBeenCalled();
    });

    it('multiple rapid hot resumes deliver every prompt to the provider', async () => {
      const sessionId = 'rapid-hot';
      const mockProvSession = createMockProviderSession({ alive: true });

      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: mockProvSession,
      });

      await manager.startSession({ prompt: 'Start', cwd: '/tmp/test' });

      // Fire three rapid hot resumes
      await Promise.all([
        manager.resumeSession({ sessionId, prompt: 'A', cwd: '/tmp/test' }),
        manager.resumeSession({ sessionId, prompt: 'B', cwd: '/tmp/test' }),
        manager.resumeSession({ sessionId, prompt: 'C', cwd: '/tmp/test' }),
      ]);

      expect(mockProvSession.sendUserMessage).toHaveBeenCalledTimes(3);
    });
  });

  // ── 3. Permission request timeout/cleanup ──

  describe('pending permission requests on session close', () => {
    it('closeSession resolves and removes pending permission requests', async () => {
      const sessionId = 'perm-leak';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      const callbacks = manager.makeCallbacks('claude-code' as any);

      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        toolUseId: 'tu-leak',
      });

      expect(manager.getPendingInputRequests()).toHaveLength(1);

      manager.closeSession(sessionId);

      // The map must be drained — leaving entries leaks both the map slot and
      // the promise the CLI side is awaiting.
      expect(manager.getPendingInputRequests()).toHaveLength(0);
      // The awaited promise must resolve (with deny) so the provider's
      // can_use_tool RPC unblocks instead of hanging forever.
      const result = await permPromise;
      expect(result.action).toBe('deny');
    });

    it('cleanup() properly resolves all pending permission requests', async () => {
      const sessionId = 'cleanup-perms';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      const callbacks = manager.makeCallbacks('claude-code' as any);

      const perm1 = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'cmd1' },
        toolUseId: 'tu-1',
      });
      const perm2 = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'cmd2' },
        toolUseId: 'tu-2',
      });

      expect(manager.getPendingInputRequests()).toHaveLength(2);

      manager.cleanup();

      // Both should resolve with 'allow'
      const [r1, r2] = await Promise.all([perm1, perm2]);
      expect(r1.action).toBe('allow');
      expect(r2.action).toBe('allow');
      expect(manager.getPendingInputRequests()).toHaveLength(0);
    });
  });

  // ── 4. getCards during session transitions ──

  describe('getCards during session transitions', () => {
    it('getCards after closeSession should fall through to JSONL-only mode', async () => {
      const sessionId = 'cards-after-close';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });
      manager.closeSession(sessionId);

      const { buildCardsFromHistory } = await import('./cardBuilder.js');
      (buildCardsFromHistory as Mock).mockResolvedValue({
        cards: [{ type: 'user', id: 'h1', text: 'historical' }],
        total: 1,
        hasMore: false,
      });

      const result = await manager.getCards(sessionId, '/tmp/test');

      // Should still work using JSONL history, no crash
      expect(result.cards).toHaveLength(1);
      expect(result.cards[0].id).toBe('h1');
      // No streaming cards appended since session is gone
      expect(buildCardsFromHistory).toHaveBeenCalled();
    });

    it('getCards for a session that never existed should not crash', async () => {
      const { buildCardsFromHistory } = await import('./cardBuilder.js');
      (buildCardsFromHistory as Mock).mockResolvedValue({
        cards: [],
        total: 0,
        hasMore: false,
      });

      const result = await manager.getCards('never-existed', '/tmp/test');
      expect(result.cards).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('getCards with offset > 0 should NOT append streaming cards (no duplication)', async () => {
      const sessionId = 'cards-paginated';
      const mockCardBuilder = {
        sessionId,
                cwd: '/tmp/test',
        jsonlCutoff: null,
        updateSessionId: vi.fn(),
        snapshotCutoff: vi.fn().mockResolvedValue(undefined),
        getCards: vi.fn().mockReturnValue([{ type: 'assistant_text', id: 'sc1', text: 'streaming' }]),
        userMessage: vi.fn(),
        clearPendingInput: vi.fn(),
        toolCallFromPermission: vi.fn(),
        startNewTurn: vi.fn(),
      };

      const { StreamCardBuilder, buildCardsFromHistory } = await import('./cardBuilder.js');
      (StreamCardBuilder as Mock).mockReturnValue(mockCardBuilder);
      (buildCardsFromHistory as Mock).mockResolvedValue({
        cards: [{ type: 'user', id: 'h1', text: 'old' }],
        total: 1,
        hasMore: false,
      });

      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      // With offset > 0, streaming cards should NOT be appended
      const result = await manager.getCards(sessionId, '/tmp/test', 1, 50);
      expect(result.cards).toHaveLength(1);
      expect(result.cards[0].id).toBe('h1');
    });
  });

  // ── 5. Event emission ordering ──

  describe('event emission ordering', () => {
    it('session-updated should fire AFTER streaming state is set to false in emitStreamEnd', async () => {
      const sessionId = 'order-check';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      const callbacks = manager.makeCallbacks('claude-code' as any);

      let streamingDuringUpdate: boolean | undefined;
      manager.on('session-updated', (evt: any) => {
        if (evt.sessionId === sessionId && evt.isStreaming === false) {
          // Verify the session's internal state is already updated when event fires
          streamingDuringUpdate = manager.isStreaming(sessionId);
        }
      });

      callbacks.emitStreamEnd({ sessionId, costUsd: 0.01 } as any);

      expect(streamingDuringUpdate).toBe(false);
    });

    it('card-stream-end fires BEFORE session-updated', async () => {
      const sessionId = 'order-events';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      const eventOrder: string[] = [];

      manager.on('card-stream-end', () => eventOrder.push('card-stream-end'));
      manager.on('session-updated', () => eventOrder.push('session-updated'));

      callbacks.emitStreamEnd({ sessionId, costUsd: 0.01 } as any);

      // emitStreamEnd emits card-stream-end first, then sets streaming=false, then emitSessionUpdate
      // The initial session-updated from startSession is already fired, so we ignore that
      // by looking at the order captured here
      expect(eventOrder[0]).toBe('card-stream-end');
      expect(eventOrder[1]).toBe('session-updated');
    });

    it('emitStreamEnd for a non-existent session should not crash', () => {
      const callbacks = manager.makeCallbacks('claude-code' as any);
      const events: any[] = [];
      manager.on('card-stream-end', (e) => events.push(e));

      // Should emit card-stream-end but not crash when trying to update non-existent session
      expect(() => {
        callbacks.emitStreamEnd({ sessionId: 'ghost', costUsd: 0 } as any);
      }).not.toThrow();

      expect(events).toHaveLength(1);
    });
  });

  // ── 6. Session config race with close ──

  describe('session config race with close', () => {
    it('setSessionConfig on a closed session should not crash', async () => {
      const sessionId = 'config-race';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });
      manager.closeSession(sessionId);

      // Should not throw
      expect(() => {
        manager.setSessionConfig(sessionId, 'model', 'claude-sonnet-4-20250514');
      }).not.toThrow();
    });

    it('setSessionConfig for sandboxed on a closed session should update the map but not crash', async () => {
      const sessionId = 'config-sandbox-race';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });
      manager.closeSession(sessionId);

      // sandboxed config sets this.sessions.get(sessionId) — which returns undefined after close
      expect(() => {
        manager.setSessionConfig(sessionId, 'sandboxed', true);
      }).not.toThrow();
    });

    it('setSessionConfig for permissionMode on a closed session should still update sessionPermissions map', async () => {
      const sessionId = 'config-perm-race';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });
      manager.closeSession(sessionId);

      // Should not throw and should store the permission for potential future cold resume
      expect(() => {
        manager.setSessionConfig(sessionId, 'permissionMode', 'bypassPermissions');
      }).not.toThrow();

      // The config is stored even though session is closed
      expect(manager.getSessionConfig(sessionId).permissionMode).toBe('bypassPermissions');
    });

    it('setSessionConfig for agent on active session should be rejected (immutable)', async () => {
      const sessionId = 'config-agent-active';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      const events: any[] = [];
      manager.on('session-config-updated', (e) => events.push(e));

      // Changing agent on an active session returns early without updating sessionAgents
      manager.setSessionConfig(sessionId, 'agent', 'codex');

      // Config key is stored in sessionConfigs, but sessionAgents is not updated
      expect(events).toHaveLength(1);
      // Agent should remain claude-code
      expect(manager.getSessionAgent(sessionId)).toBe('claude-code');
    });

    it('setSessionConfig for agent on inactive session should update sessionAgents', () => {
      const codexProvider = createMockProvider('codex', 'memory');
      const mgr = new SessionManager([provider, codexProvider]);

      mgr.setSessionConfig('inactive-session', 'agent', 'codex');
      expect(mgr.getSessionAgent('inactive-session')).toBe('codex');
    });
  });

  // ── 7. Double close / cancel ──

  describe('double close and cancel', () => {
    it('closeSession called twice should return false on the second call', async () => {
      const sessionId = 'double-close';
      const mockSession = createMockProviderSession();
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: mockSession,
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      expect(manager.closeSession(sessionId)).toBe(true);
      expect(manager.closeSession(sessionId)).toBe(false);

      // kill should only be called once
      expect(mockSession.kill).toHaveBeenCalledTimes(1);
    });

    it('cancelSession on an already-closed session should return false', async () => {
      const sessionId = 'cancel-closed';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });
      manager.closeSession(sessionId);

      expect(await manager.cancelSession(sessionId)).toBe(false);
    });

    it('cancelSession on a session with null providerSession should return false', async () => {
      const sessionId = 'cancel-null-prov';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: null, // provider returned null session
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      expect(await manager.cancelSession(sessionId)).toBe(false);
    });

    it('close followed by cancel should not throw', async () => {
      const sessionId = 'close-then-cancel';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });
      manager.closeSession(sessionId);

      // Should be safe, returns false
      expect(await manager.cancelSession(sessionId)).toBe(false);
    });

    it('cancel followed by close should work normally', async () => {
      const sessionId = 'cancel-then-close';
      const mockSession = createMockProviderSession();
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: mockSession,
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      expect(await manager.cancelSession(sessionId)).toBe(true);
      expect(mockSession.interrupt).toHaveBeenCalled();

      expect(manager.closeSession(sessionId)).toBe(true);
      expect(mockSession.kill).toHaveBeenCalled();
    });
  });

  // ── 8. Provider failure during start ──

  describe('provider failure during startSession', () => {
    it('should propagate the error and NOT leave a half-created session in the map', async () => {
      (provider.startSession as Mock).mockRejectedValue(new Error('Provider crashed'));

      await expect(
        manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' }),
      ).rejects.toThrow('Provider crashed');

      // No session should be registered since the error happened before sessions.set()
      expect(manager.getActiveSessions()).toHaveLength(0);
    });

    it('provider failure should not pollute sessionAgents map', async () => {
      (provider.startSession as Mock).mockRejectedValue(new Error('Spawn failed'));

      await expect(
        manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' }),
      ).rejects.toThrow('Spawn failed');

      // sessionAgents is set AFTER provider.startSession resolves, so on error it should be clean
      // Verify by starting a new session with a different agent
      expect(manager.getSessionAgent('any-id')).toBe('claude-code'); // default, not polluted
    });

    it('provider failure during resumeSession should clean up coldResumeInFlight', async () => {
      const sessionId = 'resume-fail';
      (provider.resumeSession as Mock).mockRejectedValue(new Error('Resume exploded'));

      await expect(
        manager.resumeSession({
          sessionId,
          prompt: 'Hello',
          cwd: '/tmp/test',
                  }),
      ).rejects.toThrow('Resume exploded');

      // coldResumeInFlight should be cleaned up via finally block
      // Verify by attempting another resume — it should NOT queue (which would happen if in-flight flag stuck)
      (provider.resumeSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      const result = await manager.resumeSession({
        sessionId,
        prompt: 'Retry',
        cwd: '/tmp/test',
              });

      expect(result).toBe(sessionId);
      expect(provider.resumeSession).toHaveBeenCalledTimes(2);
    });

    it('prompts queued during a failing cold resume should be lost', async () => {
      const sessionId = 'queue-lost';
      let resumeResolve: Function;
      const resumePromise = new Promise((resolve) => { resumeResolve = resolve; });

      (provider.resumeSession as Mock).mockImplementation(() => resumePromise);

      // Start cold resume (will block on the promise)
      const firstResume = manager.resumeSession({
        sessionId,
        prompt: 'First',
        cwd: '/tmp/test',
              });

      // Queue a second prompt while cold resume is in flight
      const secondResume = manager.resumeSession({
        sessionId,
        prompt: 'Queued',
        cwd: '/tmp/test',
              });

      // Now fail the cold resume
      resumeResolve!(Promise.reject(new Error('Resume failed')));

      await expect(firstResume).rejects.toThrow('Resume failed');
      // The second resume returns the sessionId without error (it was queued, not spawned)
      const result = await secondResume;
      expect(result).toBe(sessionId);

      // BUG: The queued prompt 'Queued' is lost — it was added to flight.queuedPrompts,
      // but the draining loop never runs because the provider threw before reaching it.
      // The prompt is silently discarded.
    });
  });

  // ── 9. Memory leak in pendingInputRequests ──

  describe('pendingInputRequests cleanup', () => {
    it('pending inputs are cleared from the map when the session closes', async () => {
      const sessionId = 'leak-test';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      const callbacks = manager.makeCallbacks('claude-code' as any);

      const p1 = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'cmd1' },
        toolUseId: 'tu-1',
      });
      const p2 = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'cmd2' },
        toolUseId: 'tu-2',
      });

      expect(manager.getPendingInputRequests()).toHaveLength(2);

      manager.closeSession(sessionId);

      expect(manager.getPendingInputRequests()).toHaveLength(0);

      const debug = manager.getDebugState();
      expect(debug.pendingInputs).toHaveLength(0);
      expect(debug.activeSessions).toHaveLength(0);

      // Both promises must resolve so the provider's can_use_tool callbacks
      // unblock — otherwise the CLI side is stuck waiting for a response that
      // will never arrive.
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.action).toBe('deny');
      expect(r2.action).toBe('deny');
    });

    it('pending inputs are cleared when the provider exits unexpectedly', async () => {
      // Same shape as closeSession but driven by the onSessionExited callback,
      // which fires on unprompted CLI exit (crash, normal exit, etc.).
      const sessionId = 'exit-leak';
      const mockSession = createMockProviderSession();
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: mockSession,
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'echo' },
        toolUseId: 'tu-exit',
      });

      expect(manager.getPendingInputRequests()).toHaveLength(1);

      // Simulate provider exit via the same callback the provider would call.
      callbacks.onSessionExited(sessionId, mockSession);

      expect(manager.getPendingInputRequests()).toHaveLength(0);
      const result = await permPromise;
      expect(result.action).toBe('deny');
    });

    it('resolveUserInput called after closeSession is a no-op (close already drained)', async () => {
      const sessionId = 'resolve-after-close';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      const callbacks = manager.makeCallbacks('claude-code' as any);

      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'echo' },
        toolUseId: 'tu-1',
      });

      const pending = manager.getPendingInputRequests();
      manager.closeSession(sessionId);

      const resolved = manager.resolveUserInput({
        sessionId,
        requestId: pending[0].requestId,
        action: 'allow',
      });

      expect(resolved).toBe(false);
      const result = await permPromise;
      expect(result.action).toBe('deny');
      expect(manager.getPendingInputRequests()).toHaveLength(0);
    });
  });

  // ── Cold resume queuing ──

  describe('cold resume queuing', () => {
    it('prompts arriving during cold resume should be queued and drained', async () => {
      const sessionId = 'cold-queue';
      let resumeResolve: Function;
      const resumeGate = new Promise<void>((resolve) => { resumeResolve = resolve; });
      const coldSession = createMockProviderSession();

      (provider.resumeSession as Mock).mockImplementation(async () => {
        await resumeGate;
        return { sessionId, session: coldSession };
      });

      // Start cold resume (will block)
      const firstResume = manager.resumeSession({
        sessionId,
        prompt: 'First',
        cwd: '/tmp/test',
              });

      // Queue additional prompts
      const secondResume = manager.resumeSession({
        sessionId,
        prompt: 'Second',
        cwd: '/tmp/test',
              });

      const thirdResume = manager.resumeSession({
        sessionId,
        prompt: 'Third',
        cwd: '/tmp/test',
              });

      // Release the gate
      resumeResolve!();

      await Promise.all([firstResume, secondResume, thirdResume]);

      // The queued prompts should have been drained via sendUserMessage
      expect(coldSession.sendUserMessage).toHaveBeenCalledWith('Second');
      expect(coldSession.sendUserMessage).toHaveBeenCalledWith('Third');
      // Provider itself handles the first prompt, so sendUserMessage is only for queued ones
      expect(coldSession.sendUserMessage).toHaveBeenCalledTimes(2);
    });

    it('rewrites pending input sessionId after a cold-resume rekey', async () => {
      // Regression: when cold resume forks a new CLI session_id, pending
      // permission requests still carried the old sessionId. resolveUserInput
      // would then look up sessions[oldId] (gone), miss the cardBuilder, and
      // never clear the PWA's pending-permission UI — visually "stuck".
      const oldId = 'rekey-old';
      const newId = 'rekey-new';

      // 1) Start with the old session id and queue a pending permission.
      (provider.startSession as Mock).mockResolvedValue({
        sessionId: oldId,
        session: createMockProviderSession(),
      });
      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      const permPromise = callbacks.handlePermissionRequest(oldId, {
        toolName: 'Bash',
        toolInput: { command: 'echo' },
        toolUseId: 'tu-rekey',
      });

      const beforeRekey = manager.getPendingInputRequests();
      expect(beforeRekey).toHaveLength(1);
      expect(beforeRekey[0].sessionId).toBe(oldId);
      const requestId = beforeRekey[0].requestId;

      // 2) Mark the providerSession as not alive so resumeSession takes the
      //    cold path (otherwise hot-resume short-circuits and never rekeys).
      const ps = (manager as any).sessions.get(oldId) as ManagedSession;
      (ps.providerSession as ProviderSession).alive = false;

      // 3) Drive cold resume; provider returns a new sessionId.
      (provider.resumeSession as Mock).mockResolvedValue({
        sessionId: newId,
        session: createMockProviderSession(),
      });
      await manager.resumeSession({
        sessionId: oldId,
        prompt: 'next',
        cwd: '/tmp/test',
              });

      // 4) The pending entry must now be tagged with the NEW sessionId so the
      //    cardBuilder lookup in resolveUserInput hits the live session entry.
      const afterRekey = manager.getPendingInputRequests();
      expect(afterRekey).toHaveLength(1);
      expect(afterRekey[0].sessionId).toBe(newId);

      // 5) Resolving via the new id (the only one in the map) must complete.
      const resolved = manager.resolveUserInput({
        sessionId: newId,
        requestId,
        action: 'allow',
      });
      expect(resolved).toBe(true);
      const result = await permPromise;
      expect(result.action).toBe('allow');
    });

    it('hasPendingInput on session-update tracks the new id after rekey', async () => {
      // Regression: buildSessionUpdatePayload computes hasPendingInput by
      // matching pending.request.sessionId. Without rewrite, the dot
      // indicator on the new sessionId would be wrong.
      const oldId = 'rekey-flag-old';
      const newId = 'rekey-flag-new';

      (provider.startSession as Mock).mockResolvedValue({
        sessionId: oldId,
        session: createMockProviderSession(),
      });
      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      void callbacks.handlePermissionRequest(oldId, {
        toolName: 'Bash',
        toolInput: { command: 'echo' },
        toolUseId: 'tu-rekey-flag',
      });

      const ps = (manager as any).sessions.get(oldId) as ManagedSession;
      (ps.providerSession as ProviderSession).alive = false;

      (provider.resumeSession as Mock).mockResolvedValue({
        sessionId: newId,
        session: createMockProviderSession(),
      });

      const updates: any[] = [];
      manager.on('session-updated', (e) => updates.push(e));
      await manager.resumeSession({
        sessionId: oldId,
        prompt: 'next',
        cwd: '/tmp/test',
              });

      const newIdUpdates = updates.filter((u) => u.sessionId === newId);
      expect(newIdUpdates.length).toBeGreaterThan(0);
      // Last emit for the new id must report hasPendingInput=true.
      expect(newIdUpdates[newIdUpdates.length - 1].hasPendingInput).toBe(true);
    });
  });

  // ── Miscellaneous edge cases ──

  describe('miscellaneous edge cases', () => {
    it('getProvider with unknown agentId should fall back to default', () => {
      // getProvider is private but exercised via startSession with bad agent
      const sessionId = 'bad-agent';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      // Should not throw — falls back to default provider
      expect(
        manager.startSession({
          prompt: 'Hello',
          cwd: '/tmp/test',
                    agent: 'nonexistent-agent' as any,
        }),
      ).resolves.toBe(sessionId);
    });

    it('SessionManager with no providers should throw on any operation', () => {
      const emptyManager = new SessionManager([]);

      // getProvider will throw because no providers exist
      expect(
        emptyManager.startSession({
          prompt: 'Hello',
          cwd: '/tmp/test',
                  }),
      ).rejects.toThrow();
    });

    it('setPreferences with both model and reasoningEffort should emit once per changed field', () => {
      const events: any[] = [];
      manager.on('preferences-updated', (e) => events.push(e));

      // Both change
      manager.setPreferences({ model: 'new-model', reasoningEffort: 'high' as any });
      expect(events).toHaveLength(1);

      // Same values — no emit
      manager.setPreferences({ model: 'new-model', reasoningEffort: 'high' as any });
      expect(events).toHaveLength(1);
    });

    it('emitSessionUpdate after close should report isActive=false and isStreaming=false', async () => {
      const sessionId = 'update-after-close';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      const updates: any[] = [];
      manager.on('session-updated', (e) => updates.push(e));

      manager.closeSession(sessionId);

      const closeUpdate = updates.find(u => u.sessionId === sessionId);
      expect(closeUpdate.isActive).toBe(false);
      expect(closeUpdate.isStreaming).toBe(false);
    });

    it('normalizeAgentId edge cases: claude-cli and claude-sdk both map to claude-code', () => {
      // Tested indirectly through setSessionConfig agent key
      const codexProvider = createMockProvider('codex', 'memory');
      const mgr = new SessionManager([provider, codexProvider]);

      mgr.setSessionConfig('s1', 'agent', 'claude-cli');
      expect(mgr.getSessionAgent('s1')).toBe('claude-code');

      mgr.setSessionConfig('s2', 'agent', 'claude-sdk');
      expect(mgr.getSessionAgent('s2')).toBe('claude-code');

      mgr.setSessionConfig('s3', 'agent', 'codex-mcp');
      expect(mgr.getSessionAgent('s3')).toBe('codex');
    });

    it('setSessionConfig with invalid agent value should not update sessionAgents', () => {
      manager.setSessionConfig('s1', 'agent', 'totally-fake');
      // Falls back to default
      expect(manager.getSessionAgent('s1')).toBe('claude-code');
    });

    it('resolveUserInput with allowPattern but session already closed should not crash', async () => {
      const sessionId = 'allow-pattern-closed';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'npm install' },
        toolUseId: 'tu-1',
      });

      const pending = manager.getPendingInputRequests();
      manager.closeSession(sessionId);

      // Resolving with allowPattern after close — ps.cwd will be undefined
      // The persistAllowPattern path should be skipped gracefully
      expect(() => {
        manager.resolveUserInput({
          sessionId,
          requestId: pending[0].requestId,
          action: 'allow',
          allowPattern: 'Bash(npm install)',
        } as any);
      }).not.toThrow();

      await permPromise;
    });
  });

  // ── Idle hot resume (reuse alive CLI between turns) ──

  describe('idle hot resume', () => {
    it('idle hot resume (streaming=false, alive=true) reuses the same provider session', async () => {
      const sessionId = 'idle-hot';
      const aliveSession = createMockProviderSession({ alive: true }) as any;
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: aliveSession,
      });

      await manager.startSession({ prompt: 'Start', cwd: '/tmp/test' });
      const cardBuilder = (StreamCardBuilder as unknown as Mock).mock.results[0].value;
      cardBuilder.userMessage.mockClear();
      cardBuilder.startNewTurn.mockClear();

      // End the first turn: streaming=false but providerSession still alive
      const callbacks = manager.makeCallbacks('claude-code' as any);
      callbacks.emitStreamEnd({ sessionId, costUsd: 0.01 } as any);

      // Resume should use idle hot resume, NOT cold resume
      const result = await manager.resumeSession({
        sessionId,
        prompt: 'Follow-up',
        cwd: '/tmp/test',
              });

      expect(result).toBe(sessionId);
      expect(aliveSession.sendUserMessage).toHaveBeenCalledWith('Follow-up');
      expect(provider.resumeSession).not.toHaveBeenCalled();
      expect(aliveSession.resultEmitted).toBe(false);
      expect(aliveSession.kill).not.toHaveBeenCalled();
      expect(cardBuilder.userMessage).not.toHaveBeenCalled();
      expect(cardBuilder.startNewTurn).not.toHaveBeenCalled();
    });

    it('idle hot resume emits session-updated with isStreaming=true', async () => {
      const sessionId = 'idle-update';
      const aliveSession = createMockProviderSession({ alive: true }) as any;
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: aliveSession,
      });

      await manager.startSession({ prompt: 'Start', cwd: '/tmp/test' });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      callbacks.emitStreamEnd({ sessionId, costUsd: 0.01 } as any);

      const updates: any[] = [];
      manager.on('session-updated', (e: any) => {
        if (e.sessionId === sessionId) updates.push(e);
      });

      await manager.resumeSession({
        sessionId,
        prompt: 'Follow-up',
        cwd: '/tmp/test',
              });

      const last = updates[updates.length - 1];
      expect(last.isActive).toBe(true);
      expect(last.isStreaming).toBe(true);
    });

    it('idle hot resume falls to cold resume when model changed', async () => {
      const sessionId = 'idle-model-changed';
      const aliveSession = createMockProviderSession({ alive: true }) as any;
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: aliveSession,
      });

      await manager.startSession({
        prompt: 'Start',
        cwd: '/tmp/test',
                model: 'claude-opus-4-5',
      });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      callbacks.emitStreamEnd({ sessionId, costUsd: 0.01 } as any);

      // User switches model — should force cold resume
      manager.setSessionConfig(sessionId, 'model', 'claude-sonnet-4-6');

      const coldSession = createMockProviderSession({ alive: true });
      (provider.resumeSession as Mock).mockResolvedValue({
        sessionId,
        session: coldSession,
      });

      await manager.resumeSession({
        sessionId,
        prompt: 'Follow-up',
        cwd: '/tmp/test',
              });

      expect(aliveSession.kill).toHaveBeenCalled();
      expect(provider.resumeSession).toHaveBeenCalled();
    });

    it('idle hot resume falls to cold resume when contextWindow changed (provider lacks updateContextWindow)', async () => {
      // The CLI provider live-switches via an `update_environment_variables`
      // stdin frame, but providers without `updateContextWindow` (SDK / Codex,
      // and this default mock) fall through and keep `spawnedContextWindow`
      // stale, which trips the resume mismatch check and forces cold respawn.
      const sessionId = 'idle-cw-changed';
      const aliveSession = createMockProviderSession({ alive: true }) as any;
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: aliveSession,
      });

      await manager.startSession({
        prompt: 'Start',
        cwd: '/tmp/test',
                model: 'claude-opus-4-7',
        contextWindow: 200_000,
      });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      callbacks.emitStreamEnd({ sessionId, costUsd: 0.01 } as any);

      // User opts up to 1M — should force cold resume even though model is the same.
      manager.setSessionConfig(sessionId, 'contextWindow', 1_000_000);

      const coldSession = createMockProviderSession({ alive: true });
      (provider.resumeSession as Mock).mockResolvedValue({
        sessionId,
        session: coldSession,
      });

      await manager.resumeSession({
        sessionId,
        prompt: 'Follow-up',
        cwd: '/tmp/test',
              });

      expect(aliveSession.kill).toHaveBeenCalled();
      expect(provider.resumeSession).toHaveBeenCalled();
      const lastResumeArgs = (provider.resumeSession as Mock).mock.calls.at(-1)?.[0];
      expect(lastResumeArgs?.contextWindow).toBe(1_000_000);
    });
  });

  // ── onSessionExited callback ──

  describe('onSessionExited callback', () => {
    it('fires session-updated with isActive=false (archived stays false — registry entry remains) when provider calls onSessionExited', async () => {
      const sessionId = 'exit-mark';
      const mockProvSession = createMockProviderSession({ alive: true });
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: mockProvSession,
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      // Mirror real behavior: startSession upserts an active registry entry,
      // so subsequent emits should see findBySessionId return it.
      const { getSessionRegistry } = await import('./sessionRegistry.js');
      const registry = (getSessionRegistry as Mock)();
      (registry.findBySessionId as Mock).mockImplementation((id: string) =>
        id === sessionId ? { sessionId, cwd: '/tmp/test' } : undefined,
      );

      const updates: any[] = [];
      manager.on('session-updated', (e: any) => {
        if (e.sessionId === sessionId) updates.push(e);
      });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      callbacks.onSessionExited!(sessionId, mockProvSession);

      const last = updates[updates.length - 1];
      expect(last.isActive).toBe(false);
      // Registry entry is still active (user can cold-resume), so archived=false.
      // The "navigate away" archived=true signal is reserved for End Task.
      expect(last.archived).toBe(false);
      expect(last.isStreaming).toBe(false);
      expect(manager.getActiveSessions().find(s => s.sessionId === sessionId)).toBeUndefined();
    });

    it('ignores stale onSessionExited callback from a replaced provider session', async () => {
      const sessionId = 'exit-stale';
      const oldProvSession = createMockProviderSession({ alive: false });
      const newProvSession = createMockProviderSession({ alive: true });
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: oldProvSession,
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      // Simulate replacement: a newer providerSession is now in the slot
      const ps = (manager as any).sessions.get(sessionId) as ManagedSession;
      ps.providerSession = newProvSession;

      const callbacks = manager.makeCallbacks('claude-code' as any);
      // Stale callback fires for the OLD provider session
      callbacks.onSessionExited!(sessionId, oldProvSession);

      // Session should still exist with the new provider
      const sessions = manager.getActiveSessions();
      expect(sessions.find(s => s.sessionId === sessionId)).toBeDefined();
      expect((manager as any).sessions.get(sessionId).providerSession).toBe(newProvSession);
    });

    it('onSessionExited on unknown session is a no-op', () => {
      const callbacks = manager.makeCallbacks('claude-code' as any);
      const mockProvSession = createMockProviderSession();
      expect(() => {
        callbacks.onSessionExited!('ghost-session', mockProvSession);
      }).not.toThrow();
    });
  });

  // ── Cold resume sessionId rekey (provider forks on --resume) ──

  describe('cold resume sessionId rekey', () => {
    it('rekeys sessions map and emits inactive for old id when provider returns a different sessionId', async () => {
      const oldId = 'old-session-id';
      const newId = 'new-session-id';

      (provider.startSession as Mock).mockResolvedValue({
        sessionId: oldId,
        session: createMockProviderSession({ alive: false }),
      });

      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test' });

      // Mirror real behavior: registry has an active entry for oldId after
      // startSession; rekey doesn't touch the registry directly.
      const { getSessionRegistry } = await import('./sessionRegistry.js');
      const registry = (getSessionRegistry as Mock)();
      (registry.findBySessionId as Mock).mockImplementation((id: string) =>
        id === oldId ? { sessionId: oldId, cwd: '/tmp/test' } : undefined,
      );

      // Persist some side-map state that should migrate with the rekey
      await manager.setSessionConfig(oldId, 'permissionMode', 'bypassPermissions');

      // End the stream and kill the provider to force cold resume
      const callbacks = manager.makeCallbacks('claude-code' as any);
      callbacks.emitStreamEnd({ sessionId: oldId, costUsd: 0 } as any);
      // Make providerSession dead so neither hot nor idle hot resume triggers
      (manager as any).sessions.get(oldId).providerSession = null;

      // Provider forks the session_id on --resume
      const coldSession = createMockProviderSession({ alive: true });
      (provider.resumeSession as Mock).mockResolvedValue({
        sessionId: newId,
        session: coldSession,
      });

      const updates: any[] = [];
      manager.on('session-updated', (e: any) => updates.push(e));

      const returned = await manager.resumeSession({
        sessionId: oldId,
        prompt: 'Follow-up',
        cwd: '/tmp/test',
              });

      expect(returned).toBe(newId);
      expect((manager as any).sessions.has(oldId)).toBe(false);
      expect((manager as any).sessions.has(newId)).toBe(true);

      // Side-map state migrated
      expect(manager.getSessionConfig(newId).permissionMode).toBe('bypassPermissions');
      expect(manager.getSessionConfig(oldId).permissionMode).toBeUndefined();

      // PWA got an inactive event for the old id and active for the new id.
      // The fork rerouter in the PWA handles cold-resume rekey separately
      // from `archived` (which is now reserved for the End Task signal).
      const oldInactive = updates.find(u => u.sessionId === oldId && u.isActive === false);
      const newActive = updates.find(u => u.sessionId === newId && u.isActive === true);
      expect(oldInactive).toBeDefined();
      expect(oldInactive.archived).toBe(false);
      expect(newActive).toBeDefined();
      expect(newActive.archived).toBe(false);
    });
  });
});
