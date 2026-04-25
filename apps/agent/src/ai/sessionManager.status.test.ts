import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { SessionManager } from './sessionManager.js';
import type {
  CodingAgentProvider,
  ProviderSession,
  ProviderCallbacks,
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

// Shared registry mock — accessible from tests via the imported getSessionRegistry.
const registryMock = {
  getEntry: vi.fn().mockReturnValue(null),
  getEntriesForProject: vi.fn().mockReturnValue([]),
  findBySessionId: vi.fn().mockReturnValue(undefined),
  upsertEntry: vi.fn(),
  updateEntry: vi.fn(),
};

vi.mock('./sessionRegistry.js', () => ({
  getSessionRegistry: vi.fn(() => registryMock),
}));

vi.mock('./sandboxMcp.js', () => ({
  SANDBOX_MCP_NAME: 'quicksave-sandbox',
  SANDBOX_MCP_PREFIX: 'mcp__quicksave-sandbox__',
  SANDBOX_BASH_TOOL: 'mcp__quicksave-sandbox__SandboxBash',
  UPDATE_SESSION_STATUS_TOOL: 'mcp__quicksave-sandbox__UpdateSessionStatus',
}));

const UPDATE_TOOL = 'mcp__quicksave-sandbox__UpdateSessionStatus';

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

describe('UpdateSessionStatus auto-approve and metadata write', () => {
  let manager: SessionManager;
  let provider: CodingAgentProvider;
  let sessionId: string;
  let callbacks: ProviderCallbacks;
  const cwd = '/tmp/status-test';

  // Apply a status update through the onToolUse hook — the real code path the
  // assistant stream drives. Permission approval is orthogonal (see the
  // "basic approval" tests that hit handlePermissionRequest directly).
  const apply = (input: Record<string, unknown>) => {
    callbacks.onToolUse!(sessionId, UPDATE_TOOL, input);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    registryMock.getEntriesForProject.mockReturnValue([]);

    provider = createMockProvider();
    manager = new SessionManager([provider]);

    sessionId = 'status-session';
    (provider.startSession as Mock).mockResolvedValue({
      sessionId,
      session: createMockProviderSession(),
    });

    await manager.startSession({
      prompt: 'Hello',
      cwd,
      streamId: 'stream-1',
    });

    // Default stub: a pre-existing registry entry for this session.
    // updateSessionStatus only upserts when getEntry returns an entry, matching
    // the real flow (startSession creates the registry entry elsewhere).
    registryMock.getEntry.mockReturnValue({
      sessionId,
      cwd,
      createdAt: 1_000,
      lastAccessedAt: 1_000,
    });

    callbacks = manager.makeCallbacks('claude-code' as any);
  });

  // ── Basic approval ──

  describe('basic approval', () => {
    it('returns { action: "allow" } for any valid input', async () => {
      const result = await callbacks.handlePermissionRequest(sessionId, {
        toolName: UPDATE_TOOL,
        toolInput: { subject: 'My Task', stage: 'working' },
        toolUseId: 'tu-allow-1',
      });
      expect(result.action).toBe('allow');
    });

    it('returns allow even when input is entirely empty', async () => {
      const result = await callbacks.handlePermissionRequest(sessionId, {
        toolName: UPDATE_TOOL,
        toolInput: {},
        toolUseId: 'tu-allow-empty',
      });
      expect(result.action).toBe('allow');
    });

    it('returns allow even when all fields are invalid types', async () => {
      const result = await callbacks.handlePermissionRequest(sessionId, {
        toolName: UPDATE_TOOL,
        toolInput: { subject: 123, stage: 42, blocked: 'yes', note: null },
        toolUseId: 'tu-allow-invalid',
      });
      expect(result.action).toBe('allow');
    });

    it('does not create a pending input request (never prompts user)', async () => {
      await callbacks.handlePermissionRequest(sessionId, {
        toolName: UPDATE_TOOL,
        toolInput: { stage: 'working' },
        toolUseId: 'tu-no-prompt',
      });
      expect(manager.getPendingInputRequests()).toHaveLength(0);
    });

    it('handlePermissionRequest does NOT persist — persistence happens via onToolUse', async () => {
      // Regression guard for the CLI auto-mode bug: the classifier can
      // pre-approve MCP tools without ever sending can_use_tool, so the
      // permission callback can't be the place that mutates state.
      await callbacks.handlePermissionRequest(sessionId, {
        toolName: UPDATE_TOOL,
        toolInput: { subject: 'Should not stick', stage: 'working' },
        toolUseId: 'tu-perm-no-persist',
      });
      expect(manager.getSessionConfig(sessionId).title).toBeUndefined();
      expect(manager.getSessionConfig(sessionId).stage).toBeUndefined();
      expect(registryMock.upsertEntry).not.toHaveBeenCalled();
    });
  });

  // ── Full-field writes ──

  describe('full-field writes', () => {
    it('writes subject → title on the session config', () => {
      apply({ subject: 'Fix the login bug' });
      expect(manager.getSessionConfig(sessionId).title).toBe('Fix the login bug');
    });

    it('writes stage on the session config', () => {
      apply({ stage: 'verifying' });
      expect(manager.getSessionConfig(sessionId).stage).toBe('verifying');
    });

    it('writes blocked=true on the session config', () => {
      apply({ blocked: true });
      expect(manager.getSessionConfig(sessionId).blocked).toBe(true);
    });

    it('writes blocked=false (distinct from omitted)', () => {
      apply({ blocked: true });
      expect(manager.getSessionConfig(sessionId).blocked).toBe(true);

      apply({ blocked: false });
      expect(manager.getSessionConfig(sessionId).blocked).toBe(false);
    });

    it('writes note on the session config', () => {
      apply({ note: 'waiting on CI' });
      expect(manager.getSessionConfig(sessionId).note).toBe('waiting on CI');
    });

    it('writes all four valid fields in one call', () => {
      apply({
        subject: 'Deploy new feature',
        stage: 'working',
        blocked: false,
        note: 'halfway through',
      });
      const cfg = manager.getSessionConfig(sessionId);
      expect(cfg.title).toBe('Deploy new feature');
      expect(cfg.stage).toBe('working');
      expect(cfg.blocked).toBe(false);
      expect(cfg.note).toBe('halfway through');
    });
  });

  // ── Partial updates / field isolation ──

  describe('partial updates', () => {
    it('a blocked-only update does not disturb existing title/stage/note', () => {
      // Seed all fields
      apply({
        subject: 'Original subject',
        stage: 'investigating',
        note: 'initial note',
      });

      // Flip just blocked
      apply({ blocked: true });

      const cfg = manager.getSessionConfig(sessionId);
      expect(cfg.title).toBe('Original subject');
      expect(cfg.stage).toBe('investigating');
      expect(cfg.note).toBe('initial note');
      expect(cfg.blocked).toBe(true);
    });

    it('a subject-only update does not overwrite existing stage/blocked/note', () => {
      apply({ stage: 'working', blocked: true, note: 'in progress' });
      apply({ subject: 'New subject' });

      const cfg = manager.getSessionConfig(sessionId);
      expect(cfg.title).toBe('New subject');
      expect(cfg.stage).toBe('working');
      expect(cfg.blocked).toBe(true);
      expect(cfg.note).toBe('in progress');
    });
  });

  // ── Invariants / invalid inputs ──

  describe('invariants for invalid inputs', () => {
    it('ignores invalid stage value "planning"', () => {
      const events: any[] = [];
      manager.on('session-config-updated', (e) => events.push(e));

      apply({ stage: 'planning' });

      expect(manager.getSessionConfig(sessionId).stage).toBeUndefined();
      expect(events).toHaveLength(0);
    });

    it('ignores arbitrary stage string', () => {
      apply({ stage: 'foo-bar' });
      expect(manager.getSessionConfig(sessionId).stage).toBeUndefined();
    });

    it('ignores empty subject string', () => {
      apply({ subject: '' });
      expect(manager.getSessionConfig(sessionId).title).toBeUndefined();
    });

    it('ignores non-string subject (number)', () => {
      apply({ subject: 42 });
      expect(manager.getSessionConfig(sessionId).title).toBeUndefined();
    });

    it('ignores non-boolean blocked (string "true")', () => {
      apply({ blocked: 'true' });
      expect(manager.getSessionConfig(sessionId).blocked).toBeUndefined();
    });

    it('ignores non-string note (object)', () => {
      apply({ note: { text: 'hi' } });
      expect(manager.getSessionConfig(sessionId).note).toBeUndefined();
    });

    it('ignores non-string stage (number)', () => {
      apply({ stage: 3 });
      expect(manager.getSessionConfig(sessionId).stage).toBeUndefined();
    });

    it('applies valid fields even when other fields are invalid in the same call', () => {
      apply({
        subject: 'Keep me',
        stage: 'not-a-stage',
        blocked: 'not-a-bool',
        note: 'also kept',
      });
      const cfg = manager.getSessionConfig(sessionId);
      expect(cfg.title).toBe('Keep me');
      expect(cfg.note).toBe('also kept');
      expect(cfg.stage).toBeUndefined();
      expect(cfg.blocked).toBeUndefined();
    });

    it('when every field is invalid/empty, no session-config-updated event fires', () => {
      const events: any[] = [];
      manager.on('session-config-updated', (e) => events.push(e));

      apply({
        subject: '',
        stage: 'bogus',
        blocked: 'nope',
        note: 12345,
      });

      expect(events).toHaveLength(0);
    });

    it('when every field is invalid/empty, no registry upsert occurs', () => {
      apply({ subject: '', stage: 'nope' });
      expect(registryMock.upsertEntry).not.toHaveBeenCalled();
    });

    it('empty input object emits no event and performs no registry write', () => {
      const events: any[] = [];
      manager.on('session-config-updated', (e) => events.push(e));

      apply({});

      expect(events).toHaveLength(0);
      expect(registryMock.upsertEntry).not.toHaveBeenCalled();
    });
  });

  // ── Accumulation across calls ──

  describe('accumulation across multiple calls', () => {
    it('merges fields across sequential calls', () => {
      apply({ subject: 'A', stage: 'investigating' });
      apply({ stage: 'working' });

      const cfg = manager.getSessionConfig(sessionId);
      expect(cfg.title).toBe('A');
      expect(cfg.stage).toBe('working');
    });

    it('later call can add fields that previous calls did not set', () => {
      apply({ subject: 'Long-running task' });
      apply({ blocked: true, note: 'hit a wall' });

      const cfg = manager.getSessionConfig(sessionId);
      expect(cfg.title).toBe('Long-running task');
      expect(cfg.blocked).toBe(true);
      expect(cfg.note).toBe('hit a wall');
    });

    it('later call can walk stage forward through the lifecycle', () => {
      const stages: Array<'investigating' | 'working' | 'verifying' | 'done'> = [
        'investigating',
        'working',
        'verifying',
        'done',
      ];
      for (const stage of stages) {
        apply({ stage });
        expect(manager.getSessionConfig(sessionId).stage).toBe(stage);
      }
    });
  });

  // ── Event emission ──

  describe('event emission', () => {
    it('emits a single session-config-updated event with the merged config', () => {
      const events: any[] = [];
      manager.on('session-config-updated', (e) => events.push(e));

      apply({ subject: 'Hello', stage: 'working', blocked: false, note: 'n' });

      expect(events.length).toBeGreaterThanOrEqual(1);
      const last = events[events.length - 1];
      expect(last.sessionId).toBe(sessionId);
      expect(last.config.title).toBe('Hello');
      expect(last.config.stage).toBe('working');
      expect(last.config.blocked).toBe(false);
      expect(last.config.note).toBe('n');
    });

    it('emitted config reflects accumulation (second call includes prior fields)', () => {
      const events: any[] = [];
      manager.on('session-config-updated', (e) => events.push(e));

      apply({ subject: 'First' });
      apply({ stage: 'working' });

      const last = events[events.length - 1];
      expect(last.sessionId).toBe(sessionId);
      expect(last.config.title).toBe('First');
      expect(last.config.stage).toBe('working');
    });
  });

  // ── Registry upsert ──

  describe('registry upsert', () => {
    it('upserts the registry entry with the written fields and a refreshed lastAccessedAt', () => {
      const before = Date.now();

      apply({
        subject: 'Ticket subject',
        stage: 'verifying',
        blocked: false,
        note: 'one step left',
      });

      expect(registryMock.upsertEntry).toHaveBeenCalled();
      const lastCall = registryMock.upsertEntry.mock.calls[registryMock.upsertEntry.mock.calls.length - 1];
      const entry = lastCall[0];

      expect(entry.sessionId).toBe(sessionId);
      expect(entry.cwd).toBe(cwd);
      expect(entry.title).toBe('Ticket subject');
      expect(entry.stage).toBe('verifying');
      expect(entry.blocked).toBe(false);
      expect(entry.note).toBe('one step left');
      expect(typeof entry.lastAccessedAt).toBe('number');
      expect(entry.lastAccessedAt).toBeGreaterThanOrEqual(before);
    });

    it('upserts only the fields supplied in a partial call', () => {
      apply({ blocked: true });

      expect(registryMock.upsertEntry).toHaveBeenCalled();
      const entry = registryMock.upsertEntry.mock.calls[registryMock.upsertEntry.mock.calls.length - 1][0];
      expect(entry.blocked).toBe(true);
    });

    it('preserves prior registry entry fields when merging a partial update', () => {
      // Simulate a pre-existing registry entry
      const prior = {
        sessionId,
        cwd,
        createdAt: 1000,
        lastAccessedAt: 2000,
        title: 'Old title',
        stage: 'investigating' as const,
        firstPrompt: 'Hello',
      };
      registryMock.getEntry.mockReturnValue(prior);

      apply({ blocked: true });

      expect(registryMock.upsertEntry).toHaveBeenCalled();
      const entry = registryMock.upsertEntry.mock.calls[registryMock.upsertEntry.mock.calls.length - 1][0];
      expect(entry.sessionId).toBe(sessionId);
      expect(entry.cwd).toBe(cwd);
      expect(entry.title).toBe('Old title');
      expect(entry.stage).toBe('investigating');
      expect(entry.firstPrompt).toBe('Hello');
      expect(entry.blocked).toBe(true);
      // lastAccessedAt should have been refreshed past the prior value
      expect(entry.lastAccessedAt).toBeGreaterThan(prior.lastAccessedAt);
    });

    it('does not upsert when only invalid/empty fields are supplied', () => {
      apply({ subject: '', stage: 'planning', blocked: 42, note: null });
      expect(registryMock.upsertEntry).not.toHaveBeenCalled();
    });
  });

  // ── noteHistory append log ──

  describe('noteHistory append log', () => {
    it('appends a single entry when note is supplied', () => {
      apply({ note: 'first finding' });

      expect(registryMock.upsertEntry).toHaveBeenCalled();
      const entry = registryMock.upsertEntry.mock.calls.at(-1)![0];
      expect(Array.isArray(entry.noteHistory)).toBe(true);
      expect(entry.noteHistory).toHaveLength(1);
      expect(entry.noteHistory[0].text).toBe('first finding');
      expect(typeof entry.noteHistory[0].ts).toBe('number');
    });

    it('appends across multiple calls, preserving order (oldest first)', () => {
      let currentHistory: Array<{ ts: number; text: string }> = [];
      // Simulate registry persistence: echo the history back on next getEntry.
      registryMock.upsertEntry.mockImplementation((entry: any) => {
        currentHistory = entry.noteHistory ?? currentHistory;
      });
      registryMock.getEntry.mockImplementation(() => ({
        sessionId,
        cwd,
        createdAt: 1_000,
        lastAccessedAt: 1_000,
        noteHistory: currentHistory,
      }));

      for (const text of ['alpha', 'beta', 'gamma']) {
        apply({ note: text });
      }

      const entry = registryMock.upsertEntry.mock.calls.at(-1)![0];
      expect(entry.noteHistory.map((n: any) => n.text)).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('caps at 50 entries, trimming oldest-first', () => {
      let currentHistory: Array<{ ts: number; text: string }> = [];
      registryMock.upsertEntry.mockImplementation((entry: any) => {
        currentHistory = entry.noteHistory ?? currentHistory;
      });
      registryMock.getEntry.mockImplementation(() => ({
        sessionId,
        cwd,
        createdAt: 1_000,
        lastAccessedAt: 1_000,
        noteHistory: currentHistory,
      }));

      for (let i = 0; i < 55; i++) {
        apply({ note: `note-${i}` });
      }

      const entry = registryMock.upsertEntry.mock.calls.at(-1)![0];
      expect(entry.noteHistory).toHaveLength(50);
      // Oldest 5 dropped; entries 5..54 retained in order.
      expect(entry.noteHistory[0].text).toBe('note-5');
      expect(entry.noteHistory.at(-1).text).toBe('note-54');
    });

    it('partial update without note does not touch existing noteHistory', () => {
      const priorHistory = [
        { ts: 1_000, text: 'existing-one' },
        { ts: 2_000, text: 'existing-two' },
      ];
      registryMock.getEntry.mockReturnValue({
        sessionId,
        cwd,
        createdAt: 1_000,
        lastAccessedAt: 1_000,
        noteHistory: priorHistory,
      });

      apply({ stage: 'verifying' });

      const entry = registryMock.upsertEntry.mock.calls.at(-1)![0];
      // Same array reference preserved (implementation only rewrites when noteToAppend is non-null).
      expect(entry.noteHistory).toBe(priorHistory);
    });

    it('empty-string note is ignored (no history entry appended)', () => {
      apply({ subject: 'Needs a subject', note: '' });

      // subject is valid → upsert happens, but noteHistory should not be created.
      expect(registryMock.upsertEntry).toHaveBeenCalled();
      const entry = registryMock.upsertEntry.mock.calls.at(-1)![0];
      expect(entry.noteHistory).toBeUndefined();
    });

    it('latest note text still mirrors to config.note for quick access', () => {
      apply({ note: 'latest-line' });
      expect(manager.getSessionConfig(sessionId).note).toBe('latest-line');
    });

    it('noteHistory entries carry monotonic timestamps across rapid calls', () => {
      let currentHistory: Array<{ ts: number; text: string }> = [];
      registryMock.upsertEntry.mockImplementation((entry: any) => {
        currentHistory = entry.noteHistory ?? currentHistory;
      });
      registryMock.getEntry.mockImplementation(() => ({
        sessionId,
        cwd,
        createdAt: 1_000,
        lastAccessedAt: 1_000,
        noteHistory: currentHistory,
      }));

      for (let i = 0; i < 5; i++) {
        apply({ note: `n${i}` });
      }

      const entry = registryMock.upsertEntry.mock.calls.at(-1)![0];
      for (let i = 1; i < entry.noteHistory.length; i++) {
        expect(entry.noteHistory[i].ts).toBeGreaterThanOrEqual(entry.noteHistory[i - 1].ts);
      }
    });
  });

  // ── Dry-run behavior ──

  describe('dry-run (no-args) behavior', () => {
    it('a no-args call after prior writes leaves config untouched', () => {
      // Seed with real values first
      apply({ subject: 'Seeded subject', stage: 'working', note: 'seeded' });
      const before = { ...manager.getSessionConfig(sessionId) };

      // Clear upsert call history so we only observe what the dry-run does
      registryMock.upsertEntry.mockClear();

      const events: any[] = [];
      manager.on('session-config-updated', (e) => events.push(e));

      apply({});

      expect(manager.getSessionConfig(sessionId)).toEqual(before);
      expect(events).toHaveLength(0);
      expect(registryMock.upsertEntry).not.toHaveBeenCalled();
    });

    it('a no-args call on a fresh session leaves status fields untouched', () => {
      apply({});
      // No valid fields → none of the status-specific keys get populated and
      // no registry upsert fires. (Other keys like `agent`/`model` are seeded
      // by startSession and are unrelated to status.)
      const cfg = manager.getSessionConfig(sessionId);
      expect(cfg.title).toBeUndefined();
      expect(cfg.stage).toBeUndefined();
      expect(cfg.blocked).toBeUndefined();
      expect(cfg.note).toBeUndefined();
      expect(registryMock.upsertEntry).not.toHaveBeenCalled();
    });

    it('a no-args call via handlePermissionRequest still returns allow', async () => {
      const result = await callbacks.handlePermissionRequest(sessionId, {
        toolName: UPDATE_TOOL,
        toolInput: {},
        toolUseId: 'tu-dry-perm',
      });
      expect(result.action).toBe('allow');
    });
  });

  // ── Interop with setSessionConfig('title', ...) path ──

  describe('interop with setSessionConfig title path', () => {
    it('UpdateSessionStatus subject overrides a prior setSessionConfig title', () => {
      manager.setSessionConfig(sessionId, 'title', 'From setSessionConfig');
      expect(manager.getSessionConfig(sessionId).title).toBe('From setSessionConfig');

      apply({ subject: 'X' });

      expect(manager.getSessionConfig(sessionId).title).toBe('X');
    });

    it('setSessionConfig title overrides a prior UpdateSessionStatus subject', () => {
      apply({ subject: 'From status' });
      expect(manager.getSessionConfig(sessionId).title).toBe('From status');

      manager.setSessionConfig(sessionId, 'title', 'Later wins');
      expect(manager.getSessionConfig(sessionId).title).toBe('Later wins');
    });
  });
});
