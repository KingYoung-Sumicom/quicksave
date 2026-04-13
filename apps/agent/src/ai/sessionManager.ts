import { EventEmitter } from 'events';
import { resolve, join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import type {
  ClaudeSessionSummary,
  ClaudeUserInputRequestPayload,
  ClaudeUserInputResponsePayload,
  ClaudePreferences,
  ConfigValue,
  CardEvent,
  CardHistoryResponse,
  CardStreamEnd,
} from '@sumicom/quicksave-shared';
import { DEFAULT_MODEL, matchAllowPattern } from '@sumicom/quicksave-shared';
import { StreamCardBuilder, buildCardsFromHistory } from './cardBuilder.js';
import { SANDBOX_BASH_TOOL, SET_TITLE_TOOL } from './sandboxMcp.js';
import { getSessionRegistry } from './sessionRegistry.js';
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
};

const DEFAULT_SYSTEM_PROMPT = [
  'For non-destructive shell commands (ls, cat, find, git log, git status, git diff, etc.), prefer SandboxBash over Bash. SandboxBash runs in a sandboxed environment. Use Bash only for commands that modify state.',
  'Call SetTitle to set a descriptive session title when you start a new task or switch context. Keep titles short (e.g. "Fixing auth middleware", "Adding unit tests for UserService"). Update it when the focus changes.',
].join('\n\n');

function buildSystemPrompt(extra?: string): string {
  return extra ? `${DEFAULT_SYSTEM_PROMPT}\n\n${extra}` : DEFAULT_SYSTEM_PROMPT;
}

export interface ManagedSession {
  sessionId: string;
  providerSession: ProviderSession | null;
  cwd: string;
  streaming: boolean;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  cardBuilder: StreamCardBuilder | null;
}

interface PendingUserInput {
  resolve: (response: ClaudeUserInputResponsePayload) => void;
  request: ClaudeUserInputRequestPayload;
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, ManagedSession> = new Map();
  private sessionPermissions: Map<string, PermissionLevel> = new Map();
  private sessionSandboxed: Map<string, boolean> = new Map();
  private sessionConfigs: Map<string, Record<string, ConfigValue>> = new Map();
  private pendingInputRequests: Map<string, PendingUserInput> = new Map();
  private requestCounter = 0;
  private runtimeAllowPatterns: string[] = [];
  private preferences: ClaudePreferences = { model: DEFAULT_MODEL };
  private provider: CodingAgentProvider;

  /** Guards against concurrent cold resumes. Queues prompts arriving while a spawn is in flight. */
  private coldResumeInFlight: Map<string, { queuedPrompts: string[] }> = new Map();

  constructor(provider: CodingAgentProvider) {
    super();
    this.provider = provider;
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

  setSessionConfig(sessionId: string, key: string, value: ConfigValue): Record<string, ConfigValue> {
    const prev = this.sessionConfigs.get(sessionId) ?? {};
    const next = { ...prev, [key]: value };
    this.sessionConfigs.set(sessionId, next);

    if (key === 'model' && typeof value === 'string') {
      this.setPreferences({ model: value });
    } else if (key === 'reasoningEffort' && (typeof value === 'string' || value === null)) {
      this.setPreferences({ reasoningEffort: value as ClaudePreferences['reasoningEffort'] });
    } else if (key === 'permissionMode' && typeof value === 'string') {
      this.setPermissionLevel(sessionId, value as PermissionLevel);
    } else if (key === 'sandboxed' && typeof value === 'boolean') {
      this.sessionSandboxed.set(sessionId, value);
      const ps = this.sessions.get(sessionId);
      if (ps) ps.sandboxed = value;
    }

    this.emit('session-config-updated', { sessionId, config: next });
    return next;
  }

  // ── Session Lifecycle ──

  async startSession(opts: {
    prompt: string;
    cwd: string;
    streamId: string;
    allowedTools?: string[];
    systemPrompt?: string;
    model?: string;
    permissionMode?: string;
    sandboxed?: boolean;
  }): Promise<string> {
    const validModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
    const level: PermissionLevel = validModes.includes(opts.permissionMode as any)
      ? (opts.permissionMode as PermissionLevel) : 'acceptEdits';

    const sandboxed = !!opts.sandboxed;
    const systemPrompt = buildSystemPrompt(opts.systemPrompt);

    // Create cardBuilder with 'pending' sessionId — will be updated after provider returns real one
    const cardBuilder = new StreamCardBuilder('pending', opts.streamId, opts.cwd);

    const callbacks = this.makeCallbacks('pending');

    const { sessionId, session: providerSession } = await this.provider.startSession(
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
    this.sessionPermissions.set(sessionId, level);
    if (sandboxed) this.sessionSandboxed.set(sessionId, true);

    const prevConfig = this.sessionConfigs.get(sessionId) ?? {};
    this.sessionConfigs.set(sessionId, {
      ...prevConfig,
      model: opts.model ?? DEFAULT_MODEL,
      permissionMode: level,
      sandboxed,
    });

    const managed: ManagedSession = {
      sessionId,
      providerSession,
      cwd: opts.cwd,
      streaming: true,
      permissionLevel: level,
      sandboxed,
      cardBuilder,
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
  }): Promise<string> {
    const existing = this.sessions.get(opts.sessionId);

    // Hot resume: session is streaming and provider session is alive
    if (existing?.streaming && existing.providerSession?.alive) {
      console.log(`[session-manager] hot resume session=${opts.sessionId.slice(0, 8)} streaming=true`);
      // Add user prompt to cardBuilder for getCards on reconnect
      if (existing.cardBuilder) {
        existing.cardBuilder.userMessage(opts.prompt);
      }
      existing.providerSession.sendUserMessage(opts.prompt);
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
      const level = this.sessionPermissions.get(opts.sessionId) ?? 'acceptEdits';
      const sandboxed = this.sessionSandboxed.get(opts.sessionId) ?? false;

      const cardBuilder = existing?.cardBuilder ?? new StreamCardBuilder(opts.sessionId, opts.streamId, opts.cwd);
      await cardBuilder.snapshotCutoff();
      const callbacks = this.makeCallbacks(opts.sessionId);

      const { sessionId, session: providerSession } = await this.provider.resumeSession(
        {
          sessionId: opts.sessionId,
          prompt: opts.prompt,
          cwd: opts.cwd,
          streamId: opts.streamId,
          permissionLevel: level,
          sandboxed,
          systemPrompt: buildSystemPrompt(),
        },
        cardBuilder,
        callbacks,
      );

      // Update or create session entry
      if (existing) {
        existing.providerSession = providerSession;
        existing.streaming = true;
      } else {
        const managed: ManagedSession = {
          sessionId,
          providerSession,
          cwd: opts.cwd,
          streaming: true,
          permissionLevel: level,
          sandboxed,
          cardBuilder,
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

  setPermissionLevel(sessionId: string, level: PermissionLevel): boolean {
    const ps = this.sessions.get(sessionId);
    if (ps) ps.permissionLevel = level;
    this.sessionPermissions.set(sessionId, level);
    this.emit('session-updated', {
      sessionId,
      isActive: !!ps,
      isStreaming: ps?.streaming ?? false,
      hasPendingInput: ps ? Array.from(this.pendingInputRequests.values()).some(p => p.request.sessionId === sessionId) : false,
      permissionMode: level,
    });
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

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getCardBuilder(sessionId: string): StreamCardBuilder | null {
    return this.sessions.get(sessionId)?.cardBuilder ?? null;
  }

  async listAvailableSessions(cwd: string): Promise<ClaudeSessionSummary[]> {
    const registry = getSessionRegistry();
    const registryEntries = registry.getEntriesForProject(cwd);

    const pendingSessionIds = new Set(
      Array.from(this.pendingInputRequests.values()).map(p => p.request.sessionId)
    );

    return registryEntries.map(entry => ({
      sessionId: entry.sessionId,
      summary: entry.title ?? entry.firstPrompt ?? entry.sessionId.slice(0, 8),
      lastModified: entry.lastAccessedAt,
      createdAt: entry.createdAt,
      cwd: entry.cwd,
      gitBranch: entry.gitBranch,
      messageCount: entry.messageCount,
      isActive: this.sessions.has(entry.sessionId),
      isStreaming: this.sessions.get(entry.sessionId)?.streaming ?? false,
      hasPendingInput: pendingSessionIds.has(entry.sessionId),
      permissionMode: this.sessions.get(entry.sessionId)?.permissionLevel
        ?? this.sessionPermissions.get(entry.sessionId),
    }));
  }

  async getCards(sessionId: string, cwd: string, offset = 0, limit = 50): Promise<CardHistoryResponse> {
    const ps = this.sessions.get(sessionId);
    const cutoff = ps?.cardBuilder?.jsonlCutoff ?? undefined;

    // Read JSONL history up to the cutoff (excludes the active turn's messages).
    const result = await buildCardsFromHistory(sessionId, cwd, offset, limit, cutoff);

    // Append in-memory cards for the active turn — no overlap, no dedup needed.
    if (ps?.cardBuilder) {
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

  makeCallbacks(_initialSessionId: string): ProviderCallbacks {
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
        this.preferences.model = model;
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

  private emitSessionUpdate(sessionId: string): void {
    const ps = this.sessions.get(sessionId);
    const hasPendingInput = Array.from(this.pendingInputRequests.values())
      .some(p => p.request.sessionId === sessionId);
    this.emit('session-updated', {
      sessionId,
      isActive: !!ps,
      isStreaming: ps?.streaming ?? false,
      hasPendingInput,
      permissionMode: ps?.permissionLevel ?? this.sessionPermissions.get(sessionId),
      sandboxed: ps?.sandboxed ?? this.sessionSandboxed.get(sessionId) ?? false,
    });
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
