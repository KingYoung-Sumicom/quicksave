import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { SessionManager, type ManagedSession } from './sessionManager.js';
import type {
  CodingAgentProvider,
  ProviderSession,
  ProviderCallbacks,
  PermissionLevel,
} from './provider.js';

// ── Mocks ──

vi.mock('./cardBuilder.js', () => {
  const StreamCardBuilder = vi.fn().mockImplementation((sessionId: string, streamId: string, cwd: string) => ({
    sessionId,
    streamId,
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

// ── Tests ──

describe('SessionManager', () => {
  let manager: SessionManager;
  let provider: CodingAgentProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createMockProvider();
    manager = new SessionManager([provider]);
  });

  // ── Constructor ──

  describe('constructor', () => {
    it('should use the provided default agent id', () => {
      const codexProvider = createMockProvider('codex', 'memory');
      const mgr = new SessionManager([provider, codexProvider], 'codex' as any);
      // Default agent should be codex — verify via getSessionAgent fallback
      expect(mgr.getSessionAgent('nonexistent')).toBe('codex');
    });

    it('should fall back to first provider if default is not found', () => {
      const mgr = new SessionManager([provider], 'nonexistent' as any);
      expect(mgr.getSessionAgent('nonexistent')).toBe('claude-code');
    });
  });

  // ── getActiveSessions ──

  describe('getActiveSessions', () => {
    it('should return empty array when no sessions exist', () => {
      expect(manager.getActiveSessions()).toEqual([]);
    });

    it('should return active sessions after starting one', async () => {
      const sessionId = 'test-session-123';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      const sessions = manager.getActiveSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(sessionId);
      expect(sessions[0].cwd).toBe('/tmp/test');
      expect(sessions[0].isStreaming).toBe(true);
      expect(sessions[0].permissionMode).toBe('acceptEdits');
    });

    it('should reflect hasPendingInput when a permission request is pending', async () => {
      const sessionId = 'test-session-pending';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      // Trigger a permission request via makeCallbacks (which will wait for user input)
      const callbacks = manager.makeCallbacks('claude-code' as any);
      // Don't await — this will block until resolved
      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        toolUseId: 'tu-1',
      });

      const sessions = manager.getActiveSessions();
      expect(sessions[0].hasPendingInput).toBe(true);

      // Clean up: resolve the pending input
      const pendingRequests = manager.getPendingInputRequests();
      expect(pendingRequests).toHaveLength(1);
      manager.resolveUserInput({
        sessionId,
        requestId: pendingRequests[0].requestId,
        action: 'allow',
      });
      await permPromise;
    });

    it('emits session-updated with hasPendingInput=true when a permission request is registered', async () => {
      // Regression: without this emit, the PWA dot indicator never flips to
      // "pending" because it only learns about hasPendingInput via the
      // session-updated event.
      const sessionId = 'pending-emit';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      const updates: any[] = [];
      manager.on('session-updated', (e: any) => {
        if (e.sessionId === sessionId) updates.push(e);
      });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        toolUseId: 'tu-pending-emit',
      });

      expect(updates.length).toBeGreaterThanOrEqual(1);
      expect(updates.at(-1).hasPendingInput).toBe(true);

      // Resolve and confirm the indicator flips back.
      const pendingRequests = manager.getPendingInputRequests();
      manager.resolveUserInput({
        sessionId,
        requestId: pendingRequests[0].requestId,
        action: 'allow',
      });
      await permPromise;

      expect(updates.at(-1).hasPendingInput).toBe(false);
    });
  });

  // ── closeSession ──

  describe('closeSession', () => {
    it('should return false for non-existent session', () => {
      expect(manager.closeSession('nonexistent')).toBe(false);
    });

    it('should kill provider session and remove from active sessions', async () => {
      const sessionId = 'close-me';
      const mockSession = createMockProviderSession();
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: mockSession,
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      expect(manager.getActiveSessions()).toHaveLength(1);

      const result = manager.closeSession(sessionId);
      expect(result).toBe(true);
      expect(mockSession.kill).toHaveBeenCalled();
      expect(manager.getActiveSessions()).toHaveLength(0);
    });

    it('should emit session-updated with isActive=false on close', async () => {
      const sessionId = 'close-emit';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      const events: any[] = [];
      manager.on('session-updated', (e) => events.push(e));

      manager.closeSession(sessionId);

      const closeEvent = events.find(e => e.isActive === false);
      expect(closeEvent).toBeDefined();
      expect(closeEvent.sessionId).toBe(sessionId);
      expect(closeEvent.isActive).toBe(false);
    });
  });

  // ── cancelSession ──

  describe('cancelSession', () => {
    it('should return false for non-existent session', async () => {
      expect(await manager.cancelSession('nonexistent')).toBe(false);
    });

    it('should call interrupt on provider session', async () => {
      const sessionId = 'cancel-me';
      const mockSession = createMockProviderSession();
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: mockSession,
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      const result = await manager.cancelSession(sessionId);
      expect(result).toBe(true);
      expect(mockSession.interrupt).toHaveBeenCalled();
    });

    it('should drain pending permission requests with deny when stop is pressed', async () => {
      // Regression: pressing stop while a permission prompt is awaiting was
      // leaving the pendingInputRequests entry behind. The CLI abandons its
      // can_use_tool RPC after interrupt, so the daemon promise would hang
      // forever and the next resolveUserInput from the PWA would land on a
      // dead promise.
      const sessionId = 'cancel-with-pending';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });
      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test', streamId: 'stream-1' });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        toolUseId: 'tu-cancel',
      });

      expect(manager.getPendingInputRequests()).toHaveLength(1);

      await manager.cancelSession(sessionId);

      expect(manager.getPendingInputRequests()).toHaveLength(0);
      const result = await permPromise;
      expect(result.action).toBe('deny');
    });

    it('should keep the session in the active map after cancel (interrupt only)', async () => {
      // Sanity: cancel must NOT close or archive the session — only interrupt.
      // Otherwise a follow-up prompt on the same session would force a cold
      // resume instead of a hot one.
      const sessionId = 'cancel-keeps-active';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });
      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test', streamId: 'stream-1' });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      void callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'echo' },
        toolUseId: 'tu-keep',
      });

      await manager.cancelSession(sessionId);

      const active = manager.getActiveSessions();
      expect(active.some((s) => s.sessionId === sessionId)).toBe(true);
    });
  });

  // ── setPermissionLevel ──

  describe('setPermissionLevel', () => {
    it('should update permission level on an active session', async () => {
      const sessionId = 'perm-session';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      manager.setPermissionLevel(sessionId, 'bypassPermissions');
      expect(manager.getPermissionLevel(sessionId)).toBe('bypassPermissions');
    });

    it('should emit session-updated with new permissionMode', async () => {
      const sessionId = 'perm-emit';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      const events: any[] = [];
      manager.on('session-updated', (e) => events.push(e));

      manager.setPermissionLevel(sessionId, 'plan');

      expect(events).toHaveLength(1);
      expect(events[0].permissionMode).toBe('plan');
    });

    it('should still work for non-active sessions (stores in separate map)', () => {
      manager.setPermissionLevel('not-active', 'bypassPermissions');
      // The internal sessionPermissions map is updated even if no active session exists
      expect(manager.getPermissionLevel('not-active')).toBe('acceptEdits');
      // Default because getPermissionLevel checks sessions map first, falls back to sessionPermissions
      // But since sessions map is empty, the fallback logic in the method returns from sessionPermissions
    });

    it('should NOT emit session-updated for inactive sessions', async () => {
      // Regression: emitting for an inactive session carries archived=true,
      // which the PWA reads as a "session retired" signal and bounces the
      // user off the page when they toggle plan mode on a cold session.
      const events: any[] = [];
      manager.on('session-updated', (e) => events.push(e));

      await manager.setPermissionLevel('cold-session', 'plan');

      expect(events).toHaveLength(0);
    });

    it('should persist the new mode to the registry for inactive sessions', async () => {
      const { getSessionRegistry } = await import('./sessionRegistry.js');
      const registry = (getSessionRegistry as Mock)();
      (registry.getEntriesForProject as Mock).mockReturnValue([
        { sessionId: 'cold-session', cwd: '/tmp/test' },
      ]);

      await manager.setPermissionLevel('cold-session', 'plan');

      expect(registry.updateEntry).toHaveBeenCalledWith(
        '/tmp/test',
        'cold-session',
        { permissionMode: 'plan' },
      );
    });
  });

  // ── shouldAutoApprove (tested via handlePermissionRequest) ──

  describe('shouldAutoApprove (via permission handling)', () => {
    let sessionId: string;
    let callbacks: ProviderCallbacks;

    beforeEach(async () => {
      sessionId = 'auto-approve-session';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      callbacks = manager.makeCallbacks('claude-code' as any);
    });

    it('should auto-approve UpdateSessionStatus tool', async () => {
      const result = await callbacks.handlePermissionRequest(sessionId, {
        toolName: 'mcp__quicksave-sandbox__UpdateSessionStatus',
        toolInput: { subject: 'My Task', stage: 'working' },
        toolUseId: 'tu-status',
      });
      expect(result.action).toBe('allow');
    });

    it('should auto-approve Edit tool in acceptEdits mode', async () => {
      const result = await callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Edit',
        toolInput: { file_path: '/tmp/test/file.ts' },
        toolUseId: 'tu-edit',
      });
      expect(result.action).toBe('allow');
    });

    it('should NOT auto-approve Edit for files outside cwd in acceptEdits mode', async () => {
      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Edit',
        toolInput: { file_path: '/etc/passwd' },
        toolUseId: 'tu-edit-outside',
      });

      // This should NOT auto-approve, so there should be a pending input
      const pending = manager.getPendingInputRequests();
      expect(pending).toHaveLength(1);

      // Resolve to clean up
      manager.resolveUserInput({
        sessionId,
        requestId: pending[0].requestId,
        action: 'allow',
      });
      await permPromise;
    });

    it('should NOT auto-approve Bash in default acceptEdits mode', async () => {
      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'echo hello' },
        toolUseId: 'tu-bash',
      });

      const pending = manager.getPendingInputRequests();
      expect(pending).toHaveLength(1);

      manager.resolveUserInput({
        sessionId,
        requestId: pending[0].requestId,
        action: 'allow',
      });
      await permPromise;
    });

    it('should auto-approve Bash in bypassPermissions mode', async () => {
      manager.setPermissionLevel(sessionId, 'bypassPermissions');

      const result = await callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'echo hello' },
        toolUseId: 'tu-bash-bypass',
      });
      expect(result.action).toBe('allow');
    });

    it('should auto-approve SandboxBash when session is sandboxed', async () => {
      // Start a sandboxed session
      const sandboxSessionId = 'sandbox-session';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId: sandboxSessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-2',
        sandboxed: true,
      });

      const result = await callbacks.handlePermissionRequest(sandboxSessionId, {
        toolName: 'mcp__quicksave-sandbox__SandboxBash',
        toolInput: { command: 'ls' },
        toolUseId: 'tu-sandbox',
      });
      expect(result.action).toBe('allow');
    });

    it('should NOT auto-approve SandboxBash with empty sessionId (pre-init race)', async () => {
      // Simulates the SDK calling canUseTool before the session is registered
      const promise = callbacks.handlePermissionRequest('', {
        toolName: 'mcp__quicksave-sandbox__SandboxBash',
        toolInput: { command: 'ls' },
        toolUseId: 'tu-sandbox-race',
      });

      // Should fall through to user prompt (not auto-approve)
      const pendingInputs = manager.getPendingInputRequests();
      expect(pendingInputs.length).toBeGreaterThanOrEqual(1);
      const req = pendingInputs.find(p => p.toolUseId === 'tu-sandbox-race');
      expect(req).toBeDefined();

      // Resolve it to unblock the promise
      manager.resolveUserInput({
        sessionId: '',
        requestId: req!.requestId,
        action: 'allow',
      });
      const result = await promise;
      expect(result.action).toBe('allow');
    });

    it('should only auto-approve EnterPlanMode in plan permission level', async () => {
      manager.setPermissionLevel(sessionId, 'plan');

      const result = await callbacks.handlePermissionRequest(sessionId, {
        toolName: 'EnterPlanMode',
        toolInput: {},
        toolUseId: 'tu-plan',
      });
      expect(result.action).toBe('allow');

      // Edit should NOT auto-approve in plan mode
      const editPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Edit',
        toolInput: { file_path: '/tmp/test/x.ts' },
        toolUseId: 'tu-edit-plan',
      });

      const pending = manager.getPendingInputRequests();
      expect(pending.length).toBeGreaterThan(0);

      manager.resolveUserInput({
        sessionId,
        requestId: pending[pending.length - 1].requestId,
        action: 'deny',
      });
      await editPromise;
    });
  });

  // ── makeCallbacks ──

  describe('makeCallbacks', () => {
    it('should emit card-event when emitCardEvent is called', () => {
      const callbacks = manager.makeCallbacks('claude-code' as any);
      const events: any[] = [];
      manager.on('card-event', (e) => events.push(e));

      const cardEvent = { type: 'add' as const, card: { type: 'assistant_text' as const, id: 'c1', text: 'hi', timestamp: Date.now() } };
      callbacks.emitCardEvent(cardEvent as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toBe(cardEvent);
    });

    it('should emit card-stream-end and set streaming=false when emitStreamEnd is called', async () => {
      const sessionId = 'stream-end-session';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      expect(manager.isStreaming(sessionId)).toBe(true);

      const callbacks = manager.makeCallbacks('claude-code' as any);
      const streamEndEvents: any[] = [];
      manager.on('card-stream-end', (e) => streamEndEvents.push(e));

      callbacks.emitStreamEnd({ sessionId, streamId: 'stream-1', costUsd: 0.01 } as any);

      expect(streamEndEvents).toHaveLength(1);
      expect(manager.isStreaming(sessionId)).toBe(false);
    });

    it('should update model preference when onModelDetected is called for claude-code', () => {
      const callbacks = manager.makeCallbacks('claude-code' as any);
      callbacks.onModelDetected('claude-sonnet-4-20250514');

      expect(manager.getPreferences().model).toBe('claude-sonnet-4-20250514');
    });

    it('should NOT update model preference for non-claude-code agents', () => {
      const codexProvider = createMockProvider('codex', 'memory');
      const mgr = new SessionManager([provider, codexProvider]);
      const callbacks = mgr.makeCallbacks('codex' as any);

      callbacks.onModelDetected('gpt-4');
      // Model should still be the default
      expect(mgr.getPreferences().model).toBe('claude-opus-4-7');
    });
  });

  // ── handlePermissionRequest (user input flow) ──

  describe('handlePermissionRequest (user input flow)', () => {
    let sessionId: string;
    let callbacks: ProviderCallbacks;

    beforeEach(async () => {
      sessionId = 'perm-flow-session';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      callbacks = manager.makeCallbacks('claude-code' as any);
    });

    it('should emit user-input-request for non-auto-approved tools', async () => {
      const requestEvents: any[] = [];
      manager.on('user-input-request', (e) => requestEvents.push(e));

      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        toolUseId: 'tu-bash',
      });

      expect(requestEvents).toHaveLength(1);
      expect(requestEvents[0].sessionId).toBe(sessionId);
      expect(requestEvents[0].inputType).toBe('permission');
      expect(requestEvents[0].toolName).toBe('Bash');

      // Resolve
      manager.resolveUserInput({
        sessionId,
        requestId: requestEvents[0].requestId,
        action: 'allow',
      });

      const result = await permPromise;
      expect(result.action).toBe('allow');
    });

    it('should return deny when user denies permission', async () => {
      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'danger' },
        toolUseId: 'tu-deny',
      });

      const pending = manager.getPendingInputRequests();
      manager.resolveUserInput({
        sessionId,
        requestId: pending[0].requestId,
        action: 'deny',
        response: 'No way',
      });

      const result = await permPromise;
      expect(result.action).toBe('deny');
      expect(result.response).toBe('No way');
    });

    it('should emit user-input-resolved when resolved', async () => {
      const resolvedEvents: any[] = [];
      manager.on('user-input-resolved', (e) => resolvedEvents.push(e));

      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'echo test' },
        toolUseId: 'tu-resolve',
      });

      const pending = manager.getPendingInputRequests();
      manager.resolveUserInput({
        sessionId,
        requestId: pending[0].requestId,
        action: 'allow',
      });

      await permPromise;

      expect(resolvedEvents).toHaveLength(1);
      expect(resolvedEvents[0].sessionId).toBe(sessionId);
      expect(resolvedEvents[0].requestId).toBe(pending[0].requestId);
    });

    it('should handle AskUserQuestion with injected answers', async () => {
      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'AskUserQuestion',
        toolInput: { questions: [{ question: 'What color?', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
        toolUseId: 'tu-ask',
      });

      const pending = manager.getPendingInputRequests();
      expect(pending[0].inputType).toBe('question');
      expect(pending[0].options).toBeDefined();

      manager.resolveUserInput({
        sessionId,
        requestId: pending[0].requestId,
        action: 'allow',
        response: 'Blue',
      });

      const result = await permPromise;
      expect(result.action).toBe('allow');
      expect(result.updatedInput).toBeDefined();
      expect((result.updatedInput as any).answers['What color?']).toBe('Blue');
    });
  });

  // ── resolveUserInput ──

  describe('resolveUserInput', () => {
    it('should return false for unknown requestId', () => {
      expect(manager.resolveUserInput({
        sessionId: 'x',
        requestId: 'unknown',
        action: 'allow',
      })).toBe(false);
    });

    it('should NOT emit session-updated when the session is no longer active', async () => {
      // Regression: if the session was removed from the in-memory map between
      // the permission request and the user's response, the session-updated
      // emit would carry archived=true and bounce the PWA off the page.
      const sessionId = 'resolve-after-exit';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });
      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test', streamId: 'stream-1' });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'echo hi' },
        toolUseId: 'tu-late',
      });

      const pending = manager.getPendingInputRequests();
      expect(pending).toHaveLength(1);

      // Simulate the CLI exiting (or being closed) before the user responds.
      manager.closeSession(sessionId);

      // Now collect events and resolve.
      const updateEvents: any[] = [];
      manager.on('session-updated', (e) => updateEvents.push(e));

      manager.resolveUserInput({
        sessionId,
        requestId: pending[0].requestId,
        action: 'allow',
      });

      await permPromise;

      expect(updateEvents).toHaveLength(0);
    });

    it('resolves two simultaneous permission requests on different sessions independently', async () => {
      // Regression: with two sessions on the same agent each holding a pending
      // permission request, resolving one must NOT disturb the other. The
      // pending map is keyed by globally-unique requestId, but each lookup
      // must use the request's own stored sessionId — never the response's
      // sessionId — so cross-session resolves stay isolated.
      const sessionA = 'two-sessions-A';
      const sessionB = 'two-sessions-B';

      // Each startSession needs its own mock return.
      (provider.startSession as Mock)
        .mockResolvedValueOnce({ sessionId: sessionA, session: createMockProviderSession() })
        .mockResolvedValueOnce({ sessionId: sessionB, session: createMockProviderSession() });

      await manager.startSession({ prompt: 'Hi A', cwd: '/tmp/a', streamId: 'stream-A' });
      await manager.startSession({ prompt: 'Hi B', cwd: '/tmp/b', streamId: 'stream-B' });

      const callbacks = manager.makeCallbacks('claude-code' as any);

      const permA = callbacks.handlePermissionRequest(sessionA, {
        toolName: 'Bash',
        toolInput: { command: 'echo A' },
        toolUseId: 'tu-A',
      });
      const permB = callbacks.handlePermissionRequest(sessionB, {
        toolName: 'Bash',
        toolInput: { command: 'echo B' },
        toolUseId: 'tu-B',
      });

      const pending = manager.getPendingInputRequests();
      expect(pending).toHaveLength(2);
      const reqA = pending.find(p => p.sessionId === sessionA)!;
      const reqB = pending.find(p => p.sessionId === sessionB)!;
      expect(reqA).toBeDefined();
      expect(reqB).toBeDefined();
      expect(reqA.requestId).not.toBe(reqB.requestId);

      const resolvedEvents: any[] = [];
      manager.on('user-input-resolved', (e) => resolvedEvents.push(e));

      // Resolve A first.
      const okA = manager.resolveUserInput({
        sessionId: sessionA,
        requestId: reqA.requestId,
        action: 'allow',
      });
      expect(okA).toBe(true);
      const resultA = await permA;
      expect(resultA.action).toBe('allow');

      // Map should still hold B's pending entry.
      expect(manager.getPendingInputRequests()).toHaveLength(1);
      expect(manager.getPendingInputRequests()[0].requestId).toBe(reqB.requestId);

      // Resolve B — must succeed independently and resolve B's promise.
      const okB = manager.resolveUserInput({
        sessionId: sessionB,
        requestId: reqB.requestId,
        action: 'deny',
        response: 'no thanks',
      });
      expect(okB).toBe(true);
      const resultB = await permB;
      expect(resultB.action).toBe('deny');
      expect(resultB.response).toBe('no thanks');

      expect(manager.getPendingInputRequests()).toHaveLength(0);

      // Both resolves should have emitted user-input-resolved with the
      // correct sessionId — proving cross-session isolation.
      expect(resolvedEvents).toHaveLength(2);
      const aResolve = resolvedEvents.find(e => e.requestId === reqA.requestId);
      const bResolve = resolvedEvents.find(e => e.requestId === reqB.requestId);
      expect(aResolve.sessionId).toBe(sessionA);
      expect(bResolve.sessionId).toBe(sessionB);
    });

    it('routes the cleared-pending card-event to the originating session, not the response sessionId', async () => {
      // Regression: the agent must use the *stored* sessionId from the pending
      // request when clearing the card, not the sessionId echoed back by the
      // PWA. If a buggy PWA sent the wrong sessionId, the agent should still
      // clear the right card. Likewise, the card-event emitted must carry the
      // originating sessionId so per-session subscribers route it correctly.
      const sessionA = 'card-route-A';
      const sessionB = 'card-route-B';

      // Build a real-ish cardBuilder per session so we can observe which
      // builder receives the clearPendingInput call. The constructor is
      // called with sessionId='pending' and then updated via updateSessionId
      // once the provider returns the real id, so we key the builders map by
      // streamId (which is stable from creation) and snapshot the real
      // sessionId when updateSessionId fires.
      const builders = new Map<string, any>();
      const { StreamCardBuilder } = await import('./cardBuilder.js');
      (StreamCardBuilder as Mock).mockImplementation((initialSessionId: string, streamId: string, cwd: string) => {
        const builder: any = {
          sessionId: initialSessionId,
          streamId,
          cwd,
          jsonlCutoff: null,
          updateSessionId: vi.fn().mockImplementation((newId: string) => {
            builder.sessionId = newId;
            builders.set(newId, builder);
          }),
          snapshotCutoff: vi.fn().mockResolvedValue(undefined),
          getCards: vi.fn().mockReturnValue([]),
          userMessage: vi.fn(),
          clearPendingInput: vi.fn().mockImplementation((_requestId: string) => ({
            type: 'update',
            cardId: `c-${builder.sessionId}`,
            sessionId: builder.sessionId,
            streamId,
            patch: { pendingInput: null },
          })),
          toolCallFromPermission: vi.fn().mockImplementation(() => ({
            type: 'add',
            card: { type: 'tool_call', id: `c-${builder.sessionId}`, toolName: 'Bash', toolUseId: 'tu' },
          })),
          startNewTurn: vi.fn(),
        };
        builders.set(streamId, builder);
        return builder;
      });

      (provider.startSession as Mock)
        .mockResolvedValueOnce({ sessionId: sessionA, session: createMockProviderSession() })
        .mockResolvedValueOnce({ sessionId: sessionB, session: createMockProviderSession() });

      await manager.startSession({ prompt: 'Hi A', cwd: '/tmp/a', streamId: 'stream-A' });
      await manager.startSession({ prompt: 'Hi B', cwd: '/tmp/b', streamId: 'stream-B' });

      const callbacks = manager.makeCallbacks('claude-code' as any);

      const permA = callbacks.handlePermissionRequest(sessionA, {
        toolName: 'Bash',
        toolInput: { command: 'echo A' },
        toolUseId: 'tu-A',
      });
      const permB = callbacks.handlePermissionRequest(sessionB, {
        toolName: 'Bash',
        toolInput: { command: 'echo B' },
        toolUseId: 'tu-B',
      });

      const pending = manager.getPendingInputRequests();
      const reqA = pending.find(p => p.sessionId === sessionA)!;
      const reqB = pending.find(p => p.sessionId === sessionB)!;

      const cardEvents: any[] = [];
      manager.on('card-event', (e) => cardEvents.push(e));

      // Resolve A — even if the response's sessionId is wrong (e.g. PWA bug),
      // the clear must hit A's builder.
      manager.resolveUserInput({
        sessionId: 'WRONG-SESSION-ID',
        requestId: reqA.requestId,
        action: 'allow',
      });
      await permA;

      expect(builders.get(sessionA)!.clearPendingInput).toHaveBeenCalledWith(reqA.requestId);
      expect(builders.get(sessionB)!.clearPendingInput).not.toHaveBeenCalled();

      const aClearEvent = cardEvents.find(e => e.type === 'update' && e.sessionId === sessionA);
      expect(aClearEvent).toBeDefined();
      expect(aClearEvent.patch.pendingInput).toBeNull();

      // Resolve B — must reach B's builder and emit B's sessionId.
      manager.resolveUserInput({
        sessionId: sessionB,
        requestId: reqB.requestId,
        action: 'allow',
      });
      await permB;

      expect(builders.get(sessionB)!.clearPendingInput).toHaveBeenCalledWith(reqB.requestId);

      const bClearEvent = cardEvents.find(e => e.type === 'update' && e.sessionId === sessionB);
      expect(bClearEvent).toBeDefined();
      expect(bClearEvent.patch.pendingInput).toBeNull();
    });

    it('should be a no-op when called for a request that closeSession already drained', async () => {
      // closeSession auto-resolves pending inputs (see edge.test.ts), so a
      // racing user response should NOT find an entry to resolve. The CLI
      // promise must still settle exactly once (with deny from close), not
      // twice or with an unexpected action.
      const sessionId = 'resolve-after-close-race';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });
      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test', streamId: 'stream-1' });

      const callbacks = manager.makeCallbacks('claude-code' as any);
      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'echo hi' },
        toolUseId: 'tu-event',
      });
      const requestId = manager.getPendingInputRequests()[0].requestId;

      manager.closeSession(sessionId);

      const lateResolved = manager.resolveUserInput({
        sessionId,
        requestId,
        action: 'allow',
      });
      // The entry was already drained by closeSession.
      expect(lateResolved).toBe(false);
      // The promise resolved once, with the close-driven deny — not the late allow.
      const result = await permPromise;
      expect(result.action).toBe('deny');
    });
  });

  // ── waitForUserInput (via handlePermissionRequest) ──

  describe('waitForUserInput emit guard', () => {
    it('should NOT emit session-updated for an inactive session', async () => {
      // Regression: waitForUserInput is invoked when the CLI asks for
      // permission. Normally the session is alive, but if it has been
      // removed (race with closeSession / onSessionExited), the emit would
      // carry archived=true and bounce the PWA.
      const sessionId = 'wait-on-inactive';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });
      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test', streamId: 'stream-1' });
      const callbacks = manager.makeCallbacks('claude-code' as any);

      // Remove the session BEFORE the permission request arrives — simulating
      // a stale callback from a CLI that has already been killed.
      manager.closeSession(sessionId);

      const updateEvents: any[] = [];
      manager.on('session-updated', (e) => updateEvents.push(e));

      // Fire and forget — we just care about the emits triggered synchronously.
      void callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'echo' },
        toolUseId: 'tu-wait-inactive',
      });

      // The pending request is still registered (caller will resolve it later)…
      expect(manager.getPendingInputRequests()).toHaveLength(1);
      // …but no session-updated event was emitted with archived=true.
      expect(updateEvents).toHaveLength(0);
    });

    it('should emit session-updated normally for an active session', async () => {
      // Positive case: when the session IS active, waitForUserInput should
      // emit so the PWA's pending-input dot indicator flips on.
      const sessionId = 'wait-on-active';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });
      await manager.startSession({ prompt: 'Hello', cwd: '/tmp/test', streamId: 'stream-1' });
      const callbacks = manager.makeCallbacks('claude-code' as any);

      const updateEvents: any[] = [];
      manager.on('session-updated', (e) => updateEvents.push(e));

      void callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'echo' },
        toolUseId: 'tu-wait-active',
      });

      expect(updateEvents.length).toBeGreaterThanOrEqual(1);
      const last = updateEvents[updateEvents.length - 1];
      expect(last.sessionId).toBe(sessionId);
      expect(last.hasPendingInput).toBe(true);
      expect(last.archived).toBe(false);
    });
  });

  // ── Preferences ──

  describe('preferences', () => {
    it('should return default preferences', () => {
      const prefs = manager.getPreferences();
      expect(prefs.model).toBe('claude-opus-4-7');
    });

    it('should update preferences and emit event', () => {
      const events: any[] = [];
      manager.on('preferences-updated', (e) => events.push(e));

      manager.setPreferences({ model: 'claude-sonnet-4-20250514' });

      expect(manager.getPreferences().model).toBe('claude-sonnet-4-20250514');
      expect(events).toHaveLength(1);
    });

    it('should not emit when setting same value', () => {
      const events: any[] = [];
      manager.on('preferences-updated', (e) => events.push(e));

      manager.setPreferences({ model: 'claude-opus-4-7' });
      expect(events).toHaveLength(0);
    });
  });

  // ── Session Config ──

  describe('session config', () => {
    it('should return empty config for unknown session', () => {
      expect(manager.getSessionConfig('unknown')).toEqual({});
    });

    it('should set and get config values', () => {
      manager.setSessionConfig('s1', 'title', 'My Session');
      expect(manager.getSessionConfig('s1').title).toBe('My Session');
    });

    it('should emit session-config-updated on setSessionConfig', () => {
      const events: any[] = [];
      manager.on('session-config-updated', (e) => events.push(e));

      manager.setSessionConfig('s1', 'key', 'value');

      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe('s1');
      expect(events[0].config.key).toBe('value');
    });

    it('should update model preference when config key is "model"', () => {
      manager.setSessionConfig('s1', 'model', 'claude-sonnet-4-20250514');
      expect(manager.getPreferences().model).toBe('claude-sonnet-4-20250514');
    });

    it('should update permission level when config key is "permissionMode"', async () => {
      const sessionId = 'config-perm';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      manager.setSessionConfig(sessionId, 'permissionMode', 'bypassPermissions');
      expect(manager.getPermissionLevel(sessionId)).toBe('bypassPermissions');
    });

    it('should update sandboxed flag when config key is "sandboxed"', async () => {
      const sessionId = 'config-sandbox';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      manager.setSessionConfig(sessionId, 'sandboxed', true);

      const sessions = manager.getActiveSessions();
      expect(sessions[0].sandboxed).toBe(true);
    });
  });

  // ── getCards ──

  describe('getCards', () => {
    it('should return cards from history for claude-jsonl provider', async () => {
      const { buildCardsFromHistory } = await import('./cardBuilder.js');
      (buildCardsFromHistory as Mock).mockResolvedValue({
        cards: [{ type: 'user', id: 'h1', text: 'old' }],
        total: 1,
        hasMore: false,
      });

      const result = await manager.getCards('some-session', '/tmp/test');
      expect(result.cards).toHaveLength(1);
      expect(result.cards[0].id).toBe('h1');
    });

    it('should append streaming cards on initial load (offset=0)', async () => {
      const sessionId = 'cards-stream';
      const mockCardBuilder = {
        sessionId,
        streamId: 'stream-1',
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

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      const result = await manager.getCards(sessionId, '/tmp/test');
      // Should have history card + streaming card
      expect(result.cards).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should use memory mode (loadPersistedCards) for memory-mode providers', async () => {
      const codexProvider = createMockProvider('codex', 'memory');
      const mgr = new SessionManager([codexProvider], 'codex' as any);

      const { loadPersistedCards } = await import('./cardBuilder.js');
      (loadPersistedCards as Mock).mockResolvedValue([
        { type: 'user', id: 'p1', text: 'persisted' },
      ]);

      const result = await mgr.getCards('some-session', '/tmp/test');
      expect(loadPersistedCards).toHaveBeenCalledWith('some-session');
      expect(result.cards).toHaveLength(1);
    });
  });

  // ── Query helpers ──

  describe('query helpers', () => {
    it('isStreaming returns false for unknown session', () => {
      expect(manager.isStreaming('unknown')).toBe(false);
    });

    it('isOpen returns false for unknown session', () => {
      expect(manager.isOpen('unknown')).toBe(false);
    });

    it('getSessionCwd returns undefined for unknown session', () => {
      expect(manager.getSessionCwd('unknown')).toBeUndefined();
    });

    it('getActiveSessionCount returns correct count', async () => {
      expect(manager.getActiveSessionCount()).toBe(0);

      (provider.startSession as Mock).mockResolvedValue({
        sessionId: 'count-1',
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      expect(manager.getActiveSessionCount()).toBe(1);
    });

    it('getCardBuilder returns null for unknown session', () => {
      expect(manager.getCardBuilder('unknown')).toBeNull();
    });
  });

  // ── startSession ──

  describe('startSession', () => {
    it('should call provider.startSession with correct params', async () => {
      const sessionId = 'new-session';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      const result = await manager.startSession({
        prompt: 'Build a thing',
        cwd: '/tmp/test',
        streamId: 'stream-1',
        model: 'claude-sonnet-4-20250514',
        permissionMode: 'bypassPermissions',
      });

      expect(result).toBe(sessionId);
      expect(provider.startSession).toHaveBeenCalled();

      const startOpts = (provider.startSession as Mock).mock.calls[0][0];
      expect(startOpts.prompt).toBe('Build a thing');
      expect(startOpts.cwd).toBe('/tmp/test');
      expect(startOpts.model).toBe('claude-sonnet-4-20250514');
      expect(startOpts.permissionLevel).toBe('bypassPermissions');
    });

    it('should default to acceptEdits for invalid permission mode', async () => {
      (provider.startSession as Mock).mockResolvedValue({
        sessionId: 'ps',
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
        permissionMode: 'invalidMode',
      });

      const startOpts = (provider.startSession as Mock).mock.calls[0][0];
      expect(startOpts.permissionLevel).toBe('acceptEdits');
    });

    it('should emit session-updated after starting', async () => {
      const sessionId = 'emit-start';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      const events: any[] = [];
      manager.on('session-updated', (e) => events.push(e));

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      const startEvent = events.find(e => e.sessionId === sessionId && e.isActive);
      expect(startEvent).toBeDefined();
      expect(startEvent.isStreaming).toBe(true);
    });
  });

  // ── cleanup ──

  describe('cleanup', () => {
    it('should kill all sessions and clear pending inputs', async () => {
      const sessionId = 'cleanup-session';
      const mockSession = createMockProviderSession();
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: mockSession,
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      manager.cleanup();

      expect(mockSession.kill).toHaveBeenCalled();
      expect(manager.getActiveSessions()).toHaveLength(0);
      expect(manager.getPendingInputRequests()).toHaveLength(0);
    });

    it('should resolve any pending input requests on cleanup', async () => {
      const sessionId = 'cleanup-pending';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      // Create a pending permission request
      const callbacks = manager.makeCallbacks('claude-code' as any);
      const permPromise = callbacks.handlePermissionRequest(sessionId, {
        toolName: 'Bash',
        toolInput: { command: 'rm' },
        toolUseId: 'tu-cleanup',
      });

      expect(manager.getPendingInputRequests()).toHaveLength(1);

      manager.cleanup();

      // The pending promise should resolve (cleanup resolves all with 'allow')
      const result = await permPromise;
      expect(result.action).toBe('allow');
    });
  });

  // ── getDebugState ──

  describe('getDebugState', () => {
    it('should return debug state with pending inputs and active sessions', async () => {
      const sessionId = 'debug-session';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await manager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
      });

      const state = manager.getDebugState();
      expect(state.activeSessions).toHaveLength(1);
      expect(state.pendingInputs).toHaveLength(0);
    });
  });

  // ── Multi-provider routing (Codex) ──

  describe('multi-provider routing', () => {
    let codexProvider: CodingAgentProvider;
    let multiManager: SessionManager;

    beforeEach(() => {
      codexProvider = createMockProvider('codex', 'memory');
      multiManager = new SessionManager([provider, codexProvider]);
    });

    it('should route to codex provider when agent=codex on start', async () => {
      const sessionId = 'codex-session-1';
      (codexProvider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await multiManager.startSession({
        prompt: 'Fix the bug',
        cwd: '/tmp/test',
        streamId: 'stream-1',
        agent: 'codex' as any,
      });

      expect(codexProvider.startSession).toHaveBeenCalled();
      expect(provider.startSession).not.toHaveBeenCalled();
    });

    it('should route to claude provider when agent=claude-code on start', async () => {
      const sessionId = 'claude-session-1';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await multiManager.startSession({
        prompt: 'Fix the bug',
        cwd: '/tmp/test',
        streamId: 'stream-1',
        agent: 'claude-code' as any,
      });

      expect(provider.startSession).toHaveBeenCalled();
      expect(codexProvider.startSession).not.toHaveBeenCalled();
    });

    it('should remember agent per session and use it on resume', async () => {
      const sessionId = 'codex-resume-1';
      const mockSession = createMockProviderSession();
      (codexProvider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: mockSession,
      });
      (codexProvider.resumeSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      // Start with codex
      await multiManager.startSession({
        prompt: 'Start',
        cwd: '/tmp/test',
        streamId: 'stream-1',
        agent: 'codex' as any,
      });

      // Close to simulate disconnect
      multiManager.closeSession(sessionId);

      // Resume without specifying agent — should use codex (remembered)
      await multiManager.resumeSession({
        sessionId,
        prompt: 'Continue',
        cwd: '/tmp/test',
        streamId: 'stream-2',
      });

      expect(codexProvider.resumeSession).toHaveBeenCalled();
      expect(provider.resumeSession).not.toHaveBeenCalled();
    });

    it('should include agent in session-updated events', async () => {
      const sessionId = 'codex-event-1';
      (codexProvider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      const events: any[] = [];
      multiManager.on('session-updated', (e) => events.push(e));

      await multiManager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
        agent: 'codex' as any,
      });

      const startEvent = events.find(e => e.sessionId === sessionId);
      expect(startEvent).toBeDefined();
      expect(startEvent.agent).toBe('codex');
    });

    it('should report agent in getActiveSessions', async () => {
      const sessionId = 'codex-active-1';
      (codexProvider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      await multiManager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
        agent: 'codex' as any,
      });

      const sessions = multiManager.getActiveSessions();
      expect(sessions).toHaveLength(1);
      expect((sessions[0] as any).agent).toBe('codex');
    });

    it('should use memory-mode getCards for codex sessions', async () => {
      const sessionId = 'codex-cards-1';
      (codexProvider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });

      const { loadPersistedCards } = await import('./cardBuilder.js');
      (loadPersistedCards as Mock).mockResolvedValue([
        { type: 'user', id: 'p1', text: 'hello from codex' },
        { type: 'assistant_text', id: 'p2', text: 'response', streaming: false },
      ]);

      // Start session to set agent
      await multiManager.startSession({
        prompt: 'Hello',
        cwd: '/tmp/test',
        streamId: 'stream-1',
        agent: 'codex' as any,
      });

      const result = await multiManager.getCards(sessionId, '/tmp/test');
      expect(loadPersistedCards).toHaveBeenCalledWith(sessionId);
      expect(result.cards.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getSessionContextUsage', () => {
    it('returns null for unknown session', async () => {
      expect(await manager.getSessionContextUsage('unknown')).toBeNull();
    });

    it('returns null when provider session does not implement getContextUsage', async () => {
      const sessionId = 'ctx-no-support';
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession(),
      });
      await manager.startSession({ prompt: 'hi', cwd: '/tmp/t', streamId: 's1' });
      expect(await manager.getSessionContextUsage(sessionId)).toBeNull();
    });

    it('delegates to provider session when supported', async () => {
      const sessionId = 'ctx-ok';
      const usage = { categories: [], totalTokens: 0, maxTokens: 200000, percentage: 0 };
      const getContextUsage = vi.fn().mockResolvedValue(usage);
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession({ getContextUsage }),
      });
      await manager.startSession({ prompt: 'hi', cwd: '/tmp/t', streamId: 's1' });

      const result = await manager.getSessionContextUsage(sessionId);
      expect(result).toBe(usage);
      expect(getContextUsage).toHaveBeenCalledTimes(1);
    });

    it('returns null when provider session is not alive', async () => {
      const sessionId = 'ctx-dead';
      const getContextUsage = vi.fn();
      (provider.startSession as Mock).mockResolvedValue({
        sessionId,
        session: createMockProviderSession({ alive: false, getContextUsage }),
      });
      await manager.startSession({ prompt: 'hi', cwd: '/tmp/t', streamId: 's1' });

      const result = await manager.getSessionContextUsage(sessionId);
      expect(result).toBeNull();
      expect(getContextUsage).not.toHaveBeenCalled();
    });
  });

  describe('snapshotActiveSessions', () => {
    it('returns an entry per active session with isActive=true and archived=false', async () => {
      let i = 0;
      (provider.startSession as Mock).mockImplementation(async () => ({
        sessionId: `snap-${++i}`,
        session: createMockProviderSession({ alive: true }),
      }));

      await manager.startSession({ prompt: 'A', cwd: '/tmp/a', streamId: 's1' });
      await manager.startSession({ prompt: 'B', cwd: '/tmp/b', streamId: 's2' });

      const snaps = manager.snapshotActiveSessions();
      expect(snaps).toHaveLength(2);
      for (const s of snaps) {
        expect(s.isActive).toBe(true);
        expect(s.archived).toBe(false);
        expect(typeof s.sessionId).toBe('string');
      }
      expect(snaps.map((s) => s.sessionId).sort()).toEqual(['snap-1', 'snap-2']);
    });

    it('does not emit session-updated events', async () => {
      (provider.startSession as Mock).mockResolvedValue({
        sessionId: 'no-emit',
        session: createMockProviderSession({ alive: true }),
      });
      await manager.startSession({ prompt: 'hi', cwd: '/tmp/t', streamId: 's1' });

      const events: unknown[] = [];
      manager.on('session-updated', (e) => events.push(e));

      manager.snapshotActiveSessions();
      expect(events).toHaveLength(0);
    });

    it('returns empty array when no sessions are active', () => {
      expect(manager.snapshotActiveSessions()).toEqual([]);
    });
  });
});
