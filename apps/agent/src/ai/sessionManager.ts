import { EventEmitter } from 'events';
import { resolve, join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import type {
  AgentId,
  ClaudeSessionSummary,
  ClaudeUserInputRequestPayload,
  ClaudeUserInputResponsePayload,
  ClaudePreferences,
  ConfigValue,
  CardEvent,
  CardHistoryResponse,
  CardStreamEnd,
  SessionUpdatePayload,
} from '@sumicom/quicksave-shared';
import {
  DEFAULT_AGENT,
  DEFAULT_MODEL,
  matchAllowPattern,
} from '@sumicom/quicksave-shared';
import { StreamCardBuilder, buildCardsFromHistory, loadPersistedCards } from './cardBuilder.js';
import { SANDBOX_BASH_TOOL, SET_TITLE_TOOL } from './sandboxMcp.js';
import { getSessionRegistry } from './sessionRegistry.js';
import { getEventStore } from '../storage/eventStore.js';
import type {
  PermissionLevel,
  ProviderSession,
  ProviderCallbacks,
  CodingAgentProvider,
} from './provider.js';

/**
 * Events emitted:
 *   'card-event'             (event: CardEvent)
 *   'card-stream-end'        (result: CardStreamEnd)
 *   'user-input-request'     (request: ClaudeUserInputRequestPayload)
 *   'user-input-resolved'    ({ requestId, sessionId })
 *   'session-updated'        ({ sessionId, isActive, isStreaming, hasPendingInput, permissionMode })
 *   'preferences-updated'    (prefs: ClaudePreferences)
 *   'session-config-updated' ({ sessionId, config: Record<string, ConfigValue> })
 */

/** Tools auto-approved at each permission level (no user prompt). */
const AUTO_APPROVE: Record<PermissionLevel, Set<string>> = {
  bypassPermissions: new Set([
    'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Agent', 'EnterWorktree', 'ExitWorktree',
    'WebFetch', 'WebSearch', 'Bash',
    'Skill', 'ToolSearch', 'Config',
    'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger',
    'EnterPlanMode', 'ExitPlanMode',
    'TaskOutput', 'TaskStop',
  ]),
  acceptEdits: new Set(['Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Agent', 'EnterWorktree', 'ExitWorktree', 'EnterPlanMode']),
  default:     new Set(['TodoWrite', 'EnterWorktree', 'ExitWorktree', 'Agent', 'EnterPlanMode']),
  plan:        new Set(['EnterPlanMode']),
  auto:        new Set(['TodoWrite', 'EnterWorktree', 'ExitWorktree', 'Agent', 'EnterPlanMode']),
};

const DEFAULT_SYSTEM_PROMPT = [
  'For non-destructive shell commands (ls, cat, find, git log, git status, git diff, etc.), prefer SandboxBash over Bash. SandboxBash runs in a sandboxed environment. Use Bash only for commands that modify state.',
  'Call SetTitle to set a descriptive session title when you start a new task or switch context. Keep titles short (e.g. "Fixing auth middleware", "Adding unit tests for UserService"). Update it when the focus changes.',
].join('\n\n');

function buildSystemPrompt(extra?: string): string {
  return extra ? `${DEFAULT_SYSTEM_PROMPT}\n\n${extra}` : DEFAULT_SYSTEM_PROMPT;
}

function normalizeAgentId(value: unknown): AgentId | undefined {
  if (value === 'claude-code' || value === 'claude-cli' || value === 'claude-sdk') {
    return 'claude-code';
  }
  if (value === 'codex' || value === 'codex-mcp') {
    return 'codex';
  }
  return undefined;
}

export interface ManagedSession {
  sessionId: string;
  agentId: AgentId;
  providerSession: ProviderSession | null;
  cwd: string;
  streaming: boolean;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  cardBuilder: StreamCardBuilder | null;
  /** Model the current provider process was spawned with. Used to force cold resume when model changes. */
  spawnedModel?: string;
}

interface PendingUserInput {
  resolve: (response: ClaudeUserInputResponsePayload) => void;
  request: ClaudeUserInputRequestPayload;
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, ManagedSession> = new Map();
  private sessionAgents: Map<string, AgentId> = new Map();
  private sessionPermissions: Map<string, PermissionLevel> = new Map();
  private sessionSandboxed: Map<string, boolean> = new Map();
  private sessionConfigs: Map<string, Record<string, ConfigValue>> = new Map();
  private pendingInputRequests: Map<string, PendingUserInput> = new Map();
  private requestCounter = 0;
  private runtimeAllowPatterns: string[] = [];
  private preferences: ClaudePreferences = { model: DEFAULT_MODEL };
  private providers: Map<AgentId, CodingAgentProvider>;
  private defaultAgentId: AgentId;

  /** Guards against concurrent cold resumes. Queues prompts arriving while a spawn is in flight. */
  private coldResumeInFlight: Map<string, { queuedPrompts: string[] }> = new Map();

  constructor(providers: CodingAgentProvider[], defaultAgentId: AgentId = DEFAULT_AGENT) {
    super();
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    this.defaultAgentId = this.providers.has(defaultAgentId)
      ? defaultAgentId
      : providers[0]?.id ?? DEFAULT_AGENT;
  }

  private getProvider(agentId?: AgentId): CodingAgentProvider {
    const resolved = agentId && this.providers.has(agentId)
      ? agentId
      : this.defaultAgentId;
    const provider = this.providers.get(resolved);
    if (!provider) {
      throw new Error(`Unknown agent: ${agentId ?? resolved}`);
    }
    return provider;
  }

  private resolveAgentId(
    sessionId: string,
    cwd?: string,
    requestedAgent?: AgentId,
  ): AgentId {
    const activeAgent = this.sessions.get(sessionId)?.agentId;
    if (activeAgent) return activeAgent;

    const rememberedAgent = this.sessionAgents.get(sessionId);
    if (rememberedAgent) return rememberedAgent;

    const rawConfig = this.sessionConfigs.get(sessionId);
    const configAgent = normalizeAgentId(rawConfig?.agent ?? rawConfig?.provider);
    if (configAgent && this.providers.has(configAgent)) {
      return configAgent;
    }

    if (cwd) {
      const registryEntry = getSessionRegistry().getEntry(cwd, sessionId);
      const registryAgent = normalizeAgentId(
        registryEntry?.agent
          ?? ((registryEntry as { provider?: string } | undefined)?.provider),
      );
      if (registryAgent && this.providers.has(registryAgent)) {
        return registryAgent;
      }
    }

    const normalizedRequest = normalizeAgentId(requestedAgent);
    if (normalizedRequest && this.providers.has(normalizedRequest)) {
      return normalizedRequest;
    }

    return this.defaultAgentId;
  }

  // ── Preferences ──

  async initPreferences(): Promise<void> {
    // Model is tracked from the last session's init event via onModelDetected callback.
  }

  getPreferences(): ClaudePreferences {
    return { ...this.preferences };
  }

  setPreferences(prefs: Partial<ClaudePreferences>): ClaudePreferences {
    const next = { ...this.preferences };
    let changed = false;

    if (prefs.model !== undefined && prefs.model !== this.preferences.model) {
      next.model = prefs.model;
      changed = true;
    }

    if (prefs.reasoningEffort !== undefined && prefs.reasoningEffort !== this.preferences.reasoningEffort) {
      next.reasoningEffort = prefs.reasoningEffort;
      changed = true;
    }

    if (changed) {
      this.preferences = next;
      this.emit('preferences-updated', this.preferences);
    }

    return { ...this.preferences };
  }

  // ── Session Config ──

  getSessionConfig(sessionId: string): Record<string, ConfigValue> {
    return { ...this.sessionConfigs.get(sessionId) };
  }

  /** Snapshot of every tracked session's config. Used by the bus
   *  `/sessions/config` subscription snapshot. */
  getAllSessionConfigs(): Record<string, Record<string, ConfigValue>> {
    const out: Record<string, Record<string, ConfigValue>> = {};
    for (const [id, cfg] of this.sessionConfigs.entries()) {
      out[id] = { ...cfg };
    }
    return out;
  }

  async setSessionConfig(sessionId: string, key: string, value: ConfigValue): Promise<Record<string, ConfigValue>> {
    const prev = this.sessionConfigs.get(sessionId) ?? {};
    const next = { ...prev, [key]: value };
    this.sessionConfigs.set(sessionId, next);

    if (key === 'model' && typeof value === 'string') {
      this.setPreferences({ model: value });
    } else if (key === 'reasoningEffort' && (typeof value === 'string' || value === null)) {
      this.setPreferences({ reasoningEffort: value as ClaudePreferences['reasoningEffort'] });
    } else if (key === 'permissionMode' && typeof value === 'string') {
      try {
        await this.setPermissionLevel(sessionId, value as PermissionLevel);
      } catch (err) {
        // CLI rejected the mode (e.g. auto mode not supported for this model/plan).
        // Roll back the optimistic config change and rethrow.
        this.sessionConfigs.set(sessionId, prev);
        this.emit('session-config-updated', { sessionId, config: prev });
        throw err;
      }
      this.persistRegistryField(sessionId, 'permissionMode', value);
    } else if (key === 'sandboxed' && typeof value === 'boolean') {
      this.sessionSandboxed.set(sessionId, value);
      const ps = this.sessions.get(sessionId);
      if (ps) ps.sandboxed = value;
      this.persistRegistryField(sessionId, 'sandboxed', value || undefined);
    } else if (key === 'agent' || key === 'provider') {
      // Reject agent changes on active sessions — agent type is immutable once spawned
      const ps = this.sessions.get(sessionId);
      if (ps) {
        this.emit('session-config-updated', { sessionId, config: next });
        return next;
      }
      const agentId = normalizeAgentId(value);
      if (!agentId || !this.providers.has(agentId)) {
        this.emit('session-config-updated', { sessionId, config: next });
        return next;
      }
      this.sessionAgents.set(sessionId, agentId);
    }

    this.emit('session-config-updated', { sessionId, config: next });
    return next;
  }

  // ── Session Lifecycle ──

  async startSession(opts: {
    prompt: string;
    cwd: string;
    streamId: string;
    agent?: AgentId;
    allowedTools?: string[];
    systemPrompt?: string;
    model?: string;
    permissionMode?: string;
    sandboxed?: boolean;
  }): Promise<string> {
    const validModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'] as const;
    const level: PermissionLevel = validModes.includes(opts.permissionMode as any)
      ? (opts.permissionMode as PermissionLevel) : 'acceptEdits';

    const sandboxed = !!opts.sandboxed;
    const systemPrompt = buildSystemPrompt(opts.systemPrompt);
    const provider = this.getProvider(opts.agent);

    // Create cardBuilder with 'pending' sessionId — will be updated after provider returns real one
    const cardBuilder = new StreamCardBuilder('pending', opts.streamId, opts.cwd);

    const callbacks = this.makeCallbacks(provider.id);

    const { sessionId, session: providerSession } = await provider.startSession(
      {
        prompt: opts.prompt,
        cwd: opts.cwd,
        streamId: opts.streamId,
        model: opts.model,
        permissionLevel: level,
        sandboxed,
        systemPrompt,
      },
      cardBuilder,
      callbacks,
    );

    // Update cardBuilder with real sessionId — new session has no prior JSONL
    cardBuilder.updateSessionId(sessionId);
    cardBuilder.jsonlCutoff = 0;

    // Update callbacks to use real sessionId (re-bind the closures)
    // The callbacks are already handed to the provider; for the permission handler
    // we capture `sessionId` from the request parameter, so this is safe.

    // Register session
    this.sessionAgents.set(sessionId, provider.id);
    this.sessionPermissions.set(sessionId, level);
    if (sandboxed) this.sessionSandboxed.set(sessionId, true);

    const prevConfig = this.sessionConfigs.get(sessionId) ?? {};
    this.sessionConfigs.set(sessionId, {
      ...prevConfig,
      agent: provider.id,
      ...((provider.id !== 'codex' && opts.model)
        ? { model: opts.model }
        : (provider.id !== 'codex' && !prevConfig.model)
          ? { model: DEFAULT_MODEL }
          : {}),
      permissionMode: level,
      sandboxed,
    });

    const managed: ManagedSession = {
      sessionId,
      agentId: provider.id,
      providerSession,
      cwd: opts.cwd,
      streaming: true,
      permissionLevel: level,
      sandboxed,
      cardBuilder,
      spawnedModel: opts.model,
    };
    this.sessions.set(sessionId, managed);
    this.emitSessionUpdate(sessionId);

    return sessionId;
  }

  async resumeSession(opts: {
    sessionId: string;
    prompt: string;
    cwd: string;
    streamId: string;
    agent?: AgentId;
  }): Promise<string> {
    const existing = this.sessions.get(opts.sessionId);
    const agentId = this.resolveAgentId(opts.sessionId, opts.cwd, opts.agent);

    // Force cold resume if the user changed model since the session was spawned.
    // The active provider process was started with `--model X`, so changing model
    // requires killing it and respawning with the new flag.
    const desiredModel = (this.sessionConfigs.get(opts.sessionId)?.model as string | undefined)
      ?? this.preferences.model;
    const modelChanged = existing?.providerSession?.alive
      && existing.spawnedModel !== undefined
      && desiredModel !== undefined
      && existing.spawnedModel !== desiredModel;

    if (modelChanged) {
      console.log(`[session-manager] model changed (${existing!.spawnedModel} → ${desiredModel}) — killing provider for cold resume session=${opts.sessionId.slice(0, 8)}`);
      existing!.providerSession!.kill();
      existing!.streaming = false;
      existing!.providerSession = null;
    }

    // Hot resume (active turn): provider is mid-turn. Queue the streamId so
    // consumeStream picks it up after the current turn's result event.
    if (existing?.streaming && existing.providerSession?.alive) {
      console.log(`[session-manager] hot resume (active) session=${opts.sessionId.slice(0, 8)}`);
      if (existing.cardBuilder) {
        existing.cardBuilder.userMessage(opts.prompt);
      }
      const ps = existing.providerSession as any;
      if (ps.pendingStreamIds) {
        ps.pendingStreamIds.push(opts.streamId);
      }
      existing.providerSession.sendUserMessage(opts.prompt);
      return opts.sessionId;
    }

    // Hot resume (idle): CLI alive but between turns — reuse the same process
    // instead of cold-resuming. Saves a kill+spawn per follow-up prompt and
    // avoids the brief isActive=false window that caused the "ghost inactive"
    // badge flicker between turns.
    if (existing?.providerSession?.alive && !modelChanged) {
      console.log(`[session-manager] hot resume (idle) session=${opts.sessionId.slice(0, 8)}`);
      const ps = existing.providerSession as any;
      if (existing.cardBuilder) {
        existing.cardBuilder.cancelDeferredClear?.();
        existing.cardBuilder.userMessage(opts.prompt);
        existing.cardBuilder.startNewTurn(opts.streamId);
      }
      ps.currentStreamId = opts.streamId;
      ps.resultEmitted = false;
      existing.streaming = true;
      existing.providerSession.sendUserMessage(opts.prompt);
      this.emitSessionUpdate(opts.sessionId);
      return opts.sessionId;
    }

    // Cold resume already in flight — queue the prompt instead of spawning again
    const inFlight = this.coldResumeInFlight.get(opts.sessionId);
    if (inFlight) {
      console.log(`[session-manager] cold resume in flight, queuing prompt for session=${opts.sessionId.slice(0, 8)}`);
      inFlight.queuedPrompts.push(opts.prompt);
      return opts.sessionId;
    }

    // Cold resume: mark as in-flight, then delegate to provider
    console.log(`[session-manager] cold resume session=${opts.sessionId.slice(0, 8)}`);
    const flight = { queuedPrompts: [] as string[] };
    this.coldResumeInFlight.set(opts.sessionId, flight);

    try {
      // Restore session settings from in-memory maps, falling back to persisted
      // registry (survives daemon restarts).
      const registryEntry = getSessionRegistry().getEntry(opts.cwd, opts.sessionId);
      const validModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'] as const;
      const restoredLevel = this.sessionPermissions.get(opts.sessionId)
        ?? (validModes.includes(registryEntry?.permissionMode as any) ? registryEntry!.permissionMode as PermissionLevel : undefined);
      const level: PermissionLevel = restoredLevel ?? 'acceptEdits';
      const sandboxed = this.sessionSandboxed.get(opts.sessionId) ?? registryEntry?.sandboxed ?? false;
      const provider = this.getProvider(agentId);

      const cardBuilder = existing?.cardBuilder ?? new StreamCardBuilder(opts.sessionId, opts.streamId, opts.cwd);
      await cardBuilder.snapshotCutoff();
      const callbacks = this.makeCallbacks(provider.id);

      const sessionConfig = this.sessionConfigs.get(opts.sessionId);
      const resumeModel = (sessionConfig?.model as string | undefined) ?? this.preferences.model;

      const { sessionId, session: providerSession } = await provider.resumeSession(
        {
          sessionId: opts.sessionId,
          prompt: opts.prompt,
          cwd: opts.cwd,
          streamId: opts.streamId,
          model: resumeModel,
          permissionLevel: level,
          sandboxed,
          systemPrompt: buildSystemPrompt(),
        },
        cardBuilder,
        callbacks,
      );

      // Update or create session entry
      this.sessionAgents.set(sessionId, provider.id);
      if (existing) {
        existing.agentId = provider.id;
        existing.sessionId = sessionId;
        existing.providerSession = providerSession;
        existing.streaming = true;
        existing.spawnedModel = resumeModel;
        // Cold resume can fork a new CLI session_id. Rekey the map + side
        // maps to the new ID so emitSessionUpdate finds the entry and the
        // PWA sees isActive=true (the ghost-inactive bug otherwise).
        if (sessionId !== opts.sessionId) {
          this.sessions.delete(opts.sessionId);
          this.sessions.set(sessionId, existing);
          this.migrateSessionIdState(opts.sessionId, sessionId);
          // Tell PWA the old id is defunct so its store doesn't keep a
          // stale active entry for the previous session_id.
          this.emitSessionUpdate(opts.sessionId);
        }
      } else {
        const managed: ManagedSession = {
          sessionId,
          agentId: provider.id,
          providerSession,
          cwd: opts.cwd,
          streaming: true,
          permissionLevel: level,
          sandboxed,
          cardBuilder,
          spawnedModel: resumeModel,
        };
        this.sessions.set(sessionId, managed);
      }

      this.emitSessionUpdate(sessionId);

      // Drain queued prompts that arrived while spawning
      for (const queued of flight.queuedPrompts) {
        console.log(`[session-manager] draining queued prompt for session=${sessionId.slice(0, 8)}`);
        providerSession.sendUserMessage(queued);
      }

      return sessionId;
    } finally {
      this.coldResumeInFlight.delete(opts.sessionId);
    }
  }

  async cancelSession(sessionId: string): Promise<boolean> {
    const ps = this.sessions.get(sessionId);
    if (!ps?.providerSession) return false;
    console.log(`[session-manager] cancel session=${sessionId.slice(0, 8)}`);
    ps.providerSession.interrupt();
    return true;
  }

  /** Send a raw control_request to the active provider session (CLI only). */
  async sendControlRequest(sessionId: string, subtype: string, params?: Record<string, unknown>): Promise<unknown> {
    const ps = this.sessions.get(sessionId);
    if (!ps?.providerSession?.alive) {
      throw new Error('Session is not active');
    }
    const session = ps.providerSession as any;
    if (typeof session.sendControlRequest !== 'function') {
      throw new Error('Provider does not support raw control_request');
    }
    return session.sendControlRequest(subtype, params);
  }

  closeSession(sessionId: string): boolean {
    const ps = this.sessions.get(sessionId);
    if (!ps) return false;
    if (ps.providerSession) {
      ps.providerSession.kill();
      ps.providerSession = null;
    }
    this.sessions.delete(sessionId);
    this.emitSessionUpdate(sessionId);
    return true;
  }

  // ── Permission ──

  async setPermissionLevel(sessionId: string, level: PermissionLevel): Promise<boolean> {
    const ps = this.sessions.get(sessionId);
    const prevLevel = ps?.permissionLevel ?? this.sessionPermissions.get(sessionId) ?? 'acceptEdits';

    if (ps) ps.permissionLevel = level;
    this.sessionPermissions.set(sessionId, level);

    const session = ps?.providerSession as any;
    if (session?.alive && typeof session.sendControlRequest === 'function') {
      try {
        await session.sendControlRequest('set_permission_mode', { mode: level });
      } catch (err) {
        // CLI rejected — roll back in-memory state so config stays consistent with the CLI.
        if (ps) ps.permissionLevel = prevLevel;
        this.sessionPermissions.set(sessionId, prevLevel);
        this.emitSessionUpdate(sessionId);
        throw err;
      }
    }

    this.emitSessionUpdate(sessionId);
    return true;
  }

  getPermissionLevel(sessionId: string): PermissionLevel {
    return this.sessions.get(sessionId)?.permissionLevel ?? 'acceptEdits';
  }

  resolveUserInput(response: ClaudeUserInputResponsePayload): boolean {
    const pending = this.pendingInputRequests.get(response.requestId);
    if (!pending) return false;
    this.pendingInputRequests.delete(response.requestId);
    pending.resolve(response);

    // Clear pending input on the card
    const ps = this.sessions.get(pending.request.sessionId);
    if (ps?.cardBuilder) {
      const cardEvt = ps.cardBuilder.clearPendingInput(response.requestId);
      if (cardEvt) this.emit('card-event', cardEvt);
    }

    // Persist allow pattern to settings.local.json if provided
    if (response.allowPattern && ps?.cwd) {
      this.persistAllowPattern(ps.cwd, response.allowPattern).catch((err) => {
        console.error('[persistAllowPattern] failed:', err);
      });
    }

    this.emit('user-input-resolved', { requestId: response.requestId, sessionId: pending.request.sessionId });
    this.emitSessionUpdate(pending.request.sessionId);
    return true;
  }

  // ── Query ──

  getActiveSessions(): { sessionId: string; cwd: string; isStreaming: boolean; hasPendingInput: boolean; permissionMode: string; sandboxed?: boolean }[] {
    const pendingSessionIds = new Set(
      Array.from(this.pendingInputRequests.values()).map(p => p.request.sessionId)
    );
    return Array.from(this.sessions.entries()).map(([id, ps]) => ({
      sessionId: id,
      cwd: ps.cwd,
      agent: ps.agentId,
      isStreaming: ps.streaming,
      hasPendingInput: pendingSessionIds.has(id),
      permissionMode: ps.permissionLevel,
      sandboxed: ps.sandboxed || undefined,
    }));
  }

  isStreaming(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.streaming ?? false;
  }

  isOpen(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getSessionCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd;
  }

  /** Fetch a live context-window breakdown from the provider. Returns null if
   * the session has no live provider process or the provider doesn't support
   * `get_context_usage` (only the claude-code CLI does). */
  async getSessionContextUsage(sessionId: string): Promise<import('@sumicom/quicksave-shared').ContextUsageBreakdown | null> {
    const ps = this.sessions.get(sessionId);
    if (!ps?.providerSession?.alive) return null;
    if (typeof ps.providerSession.getContextUsage !== 'function') return null;
    return ps.providerSession.getContextUsage();
  }

  getSessionAgent(sessionId: string, cwd?: string): AgentId {
    return this.resolveAgentId(sessionId, cwd);
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getCardBuilder(sessionId: string): StreamCardBuilder | null {
    return this.sessions.get(sessionId)?.cardBuilder ?? null;
  }

  async listAvailableSessions(cwd: string): Promise<ClaudeSessionSummary[]> {
    const registry = getSessionRegistry();
    const registryEntries = registry.getEntriesForProject(cwd)
      .filter(entry => !entry.archived);

    const pendingSessionIds = new Set(
      Array.from(this.pendingInputRequests.values()).map(p => p.request.sessionId)
    );

    const eventStore = getEventStore();
    return registryEntries.map(entry => {
      const stats = eventStore.getSessionStats(entry.sessionId);
      const lastTurn = eventStore.getLastTurn(entry.sessionId);
      return {
        sessionId: entry.sessionId,
        summary: entry.title ?? entry.firstPrompt ?? entry.sessionId.slice(0, 8),
        lastModified: entry.lastAccessedAt,
        createdAt: entry.createdAt,
        cwd: entry.cwd,
        agent: this.sessions.get(entry.sessionId)?.agentId
          ?? this.sessionAgents.get(entry.sessionId)
          ?? entry.agent
          ?? ((entry as { provider?: string }).provider === 'codex-mcp' ? 'codex' : (entry as { provider?: string }).provider ? 'claude-code' : undefined),
        gitBranch: entry.gitBranch,
        messageCount: entry.messageCount,
        isActive: this.sessions.has(entry.sessionId),
        isStreaming: this.sessions.get(entry.sessionId)?.streaming ?? false,
        hasPendingInput: pendingSessionIds.has(entry.sessionId),
        permissionMode: this.sessions.get(entry.sessionId)?.permissionLevel
          ?? this.sessionPermissions.get(entry.sessionId),
        lastPromptAt: stats.lastPromptAt ?? undefined,
        turnCount: stats.turnCount,
        totalInputTokens: stats.totalInputTokens,
        totalOutputTokens: stats.totalOutputTokens,
        totalCostUsd: stats.totalCostUsd,
        lastTurnInputTokens: lastTurn?.inputTokens,
        lastTurnCacheCreationTokens: lastTurn?.cacheCreationTokens,
        lastTurnCacheReadTokens: lastTurn?.cacheReadTokens,
        lastTurnContextUsage: lastTurn?.contextUsage as ClaudeSessionSummary['lastTurnContextUsage'],
      };
    });
  }

  async getCards(sessionId: string, cwd: string, offset = 0, limit = 50): Promise<CardHistoryResponse> {
    const ps = this.sessions.get(sessionId);
    const provider = this.getProvider(this.resolveAgentId(sessionId, cwd));
    const cutoff = ps?.cardBuilder?.jsonlCutoff ?? undefined;
    let result: CardHistoryResponse;

    if (provider.historyMode === 'claude-jsonl') {
      // Read JSONL history up to the cutoff (excludes the active turn's messages).
      result = await buildCardsFromHistory(sessionId, cwd, offset, limit, cutoff);
    } else {
      // Memory-mode: use in-memory cards from active turn, falling back to persisted history
      const streamCards = ps?.cardBuilder?.getCards() ?? [];
      const persisted = await loadPersistedCards(sessionId);
      const cards = [...persisted, ...streamCards];
      const total = cards.length;
      const start = Math.max(0, total - offset - limit);
      const end = Math.max(0, total - offset);
      result = {
        cards: cards.slice(start, end),
        total,
        hasMore: start > 0,
      };
    }

    // Append in-memory cards for the active turn (initial load only — pagination
    // already has these cards in the PWA's array, so appending them again would duplicate).
    if (offset === 0 && provider.historyMode === 'claude-jsonl' && ps?.cardBuilder) {
      const streamingCards = ps.cardBuilder.getCards();
      if (streamingCards.length > 0) {
        result.cards.push(...streamingCards);
        result.total += streamingCards.length;
      }
    }

    // Overlay pending inputs from pendingInputRequests onto matching cards.
    const pendingByToolUseId = new Map<string, any>();
    for (const [, pending] of this.pendingInputRequests) {
      if (pending.request.sessionId === sessionId && pending.request.toolUseId) {
        pendingByToolUseId.set(pending.request.toolUseId, {
          sessionId: pending.request.sessionId,
          requestId: pending.request.requestId,
          inputType: pending.request.inputType,
          title: pending.request.title,
          message: pending.request.message,
          options: pending.request.options,
        });
      }
    }

    if (pendingByToolUseId.size > 0) {
      for (const card of result.cards) {
        if (card.type === 'tool_call' && (card as any).toolUseId) {
          const pending = pendingByToolUseId.get((card as any).toolUseId);
          if (pending && !(card as any).pendingInput) {
            (card as any).pendingInput = pending;
          }
        }
      }
    }

    // Attach session title from config or registry
    const configTitle = this.sessionConfigs.get(sessionId)?.title as string | undefined;
    if (configTitle) {
      result.title = configTitle;
    } else {
      const registry = getSessionRegistry();
      const entry = registry.getEntry(cwd, sessionId);
      if (entry?.title) result.title = entry.title;
    }

    return result;
  }

  getPendingInputRequests(): ClaudeUserInputRequestPayload[] {
    return Array.from(this.pendingInputRequests.values()).map(p => p.request);
  }

  /** True when a user-input-request is outstanding for this session. Used by
   *  the daemon to avoid firing a redundant "session idle" push when the
   *  card-stream-end is actually a permission-prompt pause. */
  hasPendingInputForSession(sessionId: string): boolean {
    for (const p of this.pendingInputRequests.values()) {
      if (p.request.sessionId === sessionId) return true;
    }
    return false;
  }

  getDebugState() {
    const pendingInputs = Array.from(this.pendingInputRequests.values()).map(p => ({
      requestId: p.request.requestId,
      sessionId: p.request.sessionId,
      toolName: p.request.toolName,
      agentId: (p.request as any).agentId,
      inputType: p.request.inputType,
    }));
    return { pendingInputs, activeSessions: this.getActiveSessions() };
  }

  cleanup(): void {
    for (const [requestId, pending] of this.pendingInputRequests) {
      pending.resolve({ sessionId: '', requestId, action: 'allow' });
    }
    this.pendingInputRequests.clear();

    for (const [, ps] of this.sessions) {
      if (ps.providerSession) {
        try { ps.providerSession.kill(); } catch {}
        ps.providerSession = null;
      }
    }
    this.sessions.clear();
  }

  // ── Private: Callbacks Factory ──

  makeCallbacks(agentId: AgentId): ProviderCallbacks {
    return {
      emitCardEvent: (event: CardEvent) => {
        this.emit('card-event', event);
      },
      emitStreamEnd: (result: CardStreamEnd) => {
        this.emit('card-stream-end', result);
        // Update session streaming state
        const ps = this.sessions.get(result.sessionId);
        if (ps) {
          ps.streaming = false;
          this.emitSessionUpdate(result.sessionId);
        }
      },
      handlePermissionRequest: async (
        sessionId: string,
        req: { toolName: string; toolInput: Record<string, unknown>; toolUseId: string },
      ) => {
        return this.handlePermissionRequest(sessionId, req);
      },
      onModelDetected: (model: string) => {
        console.log(`[session-manager] model detected: ${model} (agent=${agentId})`);
        if (agentId === 'claude-code') {
          this.preferences.model = model;
        }
      },
      onSessionExited: (sessionId, providerSession) => {
        const ps = this.sessions.get(sessionId);
        // Stale callback — a newer provider has already taken this slot
        // (e.g. cold resume killed this one and spawned a fresh CLI).
        if (!ps || ps.providerSession !== providerSession) return;
        console.log(`[session-manager] provider exited session=${sessionId.slice(0, 8)} — marking inactive`);
        ps.providerSession = null;
        ps.streaming = false;
        this.sessions.delete(sessionId);
        this.emitSessionUpdate(sessionId);
      },
    };
  }

  // ── Private: Permission Handling ──

  private async handlePermissionRequest(
    sessionId: string,
    req: { toolName: string; toolInput: Record<string, unknown>; toolUseId: string },
  ): Promise<{ action: 'allow' | 'deny'; response?: string; updatedInput?: Record<string, unknown> }> {
    const { toolName, toolInput, toolUseId } = req;

    // Check auto-approve rules first
    if (this.shouldAutoApprove(sessionId, toolName, toolInput)) {
      return { action: 'allow' };
    }

    // Check runtime allow patterns
    if (this.runtimeAllowPatterns.some(p => matchAllowPattern(p, toolName, toolInput))) {
      return { action: 'allow' };
    }

    // Forward to PWA for user decision
    const requestId = `perm-${++this.requestCounter}`;

    const isQuestion = toolName === 'AskUserQuestion';
    const questions = isQuestion ? (toolInput as any).questions : undefined;

    const request: ClaudeUserInputRequestPayload = {
      sessionId,
      requestId,
      inputType: isQuestion ? 'question' : 'permission',
      title: isQuestion
        ? questions?.[0]?.question ?? 'Question from Claude'
        : `Allow ${toolName}?`,
      message: isQuestion ? undefined : JSON.stringify(toolInput).slice(0, 500),
      toolName,
      toolInput,
      toolUseId,
      ...(isQuestion && questions ? {
        options: questions.flatMap((q: any) =>
          (q.options ?? []).map((opt: any) => ({
            key: opt.label,
            label: opt.label,
            description: opt.description,
          }))
        ),
      } : {}),
    };

    // Create card with pending input
    const ps = this.sessions.get(sessionId);
    const cb = ps?.cardBuilder;
    if (cb) {
      const pendingAttachment = {
        sessionId,
        requestId,
        inputType: request.inputType,
        title: request.title,
        message: request.message,
        options: request.options,
      };
      const cardEvt = cb.toolCallFromPermission(toolName, toolInput, toolUseId, pendingAttachment);
      this.emit('card-event', cardEvt);
    }

    this.emit('user-input-request', request);

    // Wait for user response
    const response = await this.waitForUserInput(requestId, request);

    if (response.action === 'deny') {
      return { action: 'deny', response: response.response || 'User denied permission' };
    }

    // For AskUserQuestion, inject answer
    if (isQuestion && response.response) {
      const answers: Record<string, string> = {};
      if (questions?.[0]?.question) {
        answers[questions[0].question] = response.response;
      }
      return { action: 'allow', updatedInput: { ...toolInput, answers } };
    }

    return { action: 'allow' };
  }

  private shouldAutoApprove(sessionId: string, toolName: string, input: Record<string, unknown>): boolean {
    // SetTitle — always approve
    if (toolName === SET_TITLE_TOOL) {
      if (input.title) this.updateSessionTitle(sessionId, input.title as string);
      return true;
    }

    // SandboxBash: auto-approve when sandboxed, otherwise check as Bash
    if (toolName === SANDBOX_BASH_TOOL) {
      if (this.sessions.get(sessionId)?.sandboxed) return true;
      toolName = 'Bash';  // fall through to permission check as Bash
    }

    // Check permission level auto-approve set
    const level = this.sessions.get(sessionId)?.permissionLevel
      ?? this.sessionPermissions.get(sessionId) ?? 'acceptEdits';

    if (!AUTO_APPROVE[level].has(toolName)) return false;

    // For file-writing tools, restrict to project cwd
    const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
    if (FILE_WRITE_TOOLS.has(toolName)) {
      const cwd = this.sessions.get(sessionId)?.cwd;
      const filePath = (input.file_path ?? input.path) as string | undefined;
      if (filePath && cwd) {
        const resolvedFile = resolve(filePath);
        const resolvedCwd = resolve(cwd);
        return resolvedFile === resolvedCwd || resolvedFile.startsWith(resolvedCwd + '/');
      }
    }

    return true;
  }

  /** Update session title (triggered by SetTitle MCP tool). */
  private updateSessionTitle(sessionId: string, title: string): void {
    const config = this.sessionConfigs.get(sessionId) ?? {};
    this.sessionConfigs.set(sessionId, { ...config, title });
    this.emit('session-config-updated', { sessionId, config: this.sessionConfigs.get(sessionId) });

    // Update session registry so it persists across restarts
    const ps = this.sessions.get(sessionId);
    if (ps?.cwd) {
      const registry = getSessionRegistry();
      const entry = registry.getEntry(ps.cwd, sessionId);
      if (entry) {
        registry.upsertEntry({ ...entry, title, lastAccessedAt: Date.now() });
      }
    }
  }

  /** Move per-session state from oldId to newId after the CLI forks on
   * --resume. `sessionAgents[newId]` is already set by the caller; this
   * helper moves the remaining side maps and clears the old key. */
  private migrateSessionIdState(oldId: string, newId: string): void {
    const permission = this.sessionPermissions.get(oldId);
    if (permission !== undefined) {
      this.sessionPermissions.set(newId, permission);
      this.sessionPermissions.delete(oldId);
    }
    const sandboxed = this.sessionSandboxed.get(oldId);
    if (sandboxed !== undefined) {
      this.sessionSandboxed.set(newId, sandboxed);
      this.sessionSandboxed.delete(oldId);
    }
    const config = this.sessionConfigs.get(oldId);
    if (config !== undefined) {
      this.sessionConfigs.set(newId, config);
      this.sessionConfigs.delete(oldId);
    }
    this.sessionAgents.delete(oldId);
  }

  private emitSessionUpdate(sessionId: string): void {
    this.emit('session-updated', this.buildSessionUpdatePayload(sessionId));
  }

  /**
   * Build the payload normally shipped via the `session-updated` event without
   * emitting. Used by daemon-level code that wants to push a fresh snapshot to
   * a specific peer (e.g. PWA reconnect) instead of triggering a broadcast.
   */
  buildSessionUpdatePayload(sessionId: string): SessionUpdatePayload {
    const ps = this.sessions.get(sessionId);
    const hasPendingInput = Array.from(this.pendingInputRequests.values())
      .some(p => p.request.sessionId === sessionId);
    const eventStore = getEventStore();
    const stats = eventStore.getSessionStats(sessionId);
    const lastTurn = eventStore.getLastTurn(sessionId);
    return {
      sessionId,
      isActive: !!ps,
      // `archived` = session has been removed from the in-memory map
      // (cold-resume rekey, onSessionExited, or closeSession). PWA uses this
      // as a signal to navigate away from the now-defunct session page.
      // Note: isActive=false alone is ambiguous (can also mean "emitted for
      // an unknown id during reconcile"); archived=true is the strong signal.
      archived: !ps,
      agent: ps?.agentId ?? this.sessionAgents.get(sessionId),
      isStreaming: ps?.streaming ?? false,
      hasPendingInput,
      permissionMode: ps?.permissionLevel ?? this.sessionPermissions.get(sessionId),
      sandboxed: ps?.sandboxed ?? this.sessionSandboxed.get(sessionId) ?? false,
      lastPromptAt: stats.lastPromptAt ?? undefined,
      turnCount: stats.turnCount,
      totalInputTokens: stats.totalInputTokens,
      totalOutputTokens: stats.totalOutputTokens,
      totalCostUsd: stats.totalCostUsd,
      lastTurnInputTokens: lastTurn?.inputTokens,
      lastTurnCacheCreationTokens: lastTurn?.cacheCreationTokens,
      lastTurnCacheReadTokens: lastTurn?.cacheReadTokens,
      lastTurnContextUsage: lastTurn?.contextUsage as SessionUpdatePayload['lastTurnContextUsage'],
    };
  }

  /** Snapshot of every active (in-memory) session's state. Delivered via the
   *  bus `/sessions/active` snap frame on subscribe; subsequent incremental
   *  updates are published per session via the same path. */
  snapshotActiveSessions(): SessionUpdatePayload[] {
    return Array.from(this.sessions.keys()).map((id) => this.buildSessionUpdatePayload(id));
  }

  private persistRegistryField(sessionId: string, key: string, value: unknown): void {
    const registry = getSessionRegistry();
    // Active session — cwd is in memory
    const cwd = this.sessions.get(sessionId)?.cwd;
    if (cwd) {
      registry.updateEntry(cwd, sessionId, { [key]: value } as any);
      return;
    }
    // Inactive session — scan registry for the entry
    for (const entry of registry.getEntriesForProject()) {
      if (entry.sessionId === sessionId) {
        registry.updateEntry(entry.cwd, sessionId, { [key]: value } as any);
        return;
      }
    }
  }

  private async persistAllowPattern(cwd: string, pattern: string): Promise<void> {
    if (!this.runtimeAllowPatterns.includes(pattern)) {
      this.runtimeAllowPatterns.push(pattern);
    }

    const settingsPath = join(cwd, '.claude', 'settings.local.json');
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    } catch { /* file doesn't exist yet */ }

    const permissions = settings.permissions as Record<string, unknown> ?? {};
    const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
    if (!allow.includes(pattern)) {
      allow.push(pattern);
      settings.permissions = { ...permissions, allow };
      await mkdir(join(cwd, '.claude'), { recursive: true });
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log(`[persistAllowPattern] saved ${pattern} to ${settingsPath}`);
    }
  }

  private waitForUserInput(
    requestId: string,
    request: ClaudeUserInputRequestPayload,
  ): Promise<ClaudeUserInputResponsePayload> {
    return new Promise((resolve) => {
      this.pendingInputRequests.set(requestId, { resolve, request });
    });
  }
}
