import { EventEmitter } from 'events';
import { resolve } from 'path';
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  listSessions,
  getSessionMessages,
  listSubagents,
  getSubagentMessages,
} from '@anthropic-ai/claude-agent-sdk';
import type { SDKSession } from '@anthropic-ai/claude-agent-sdk';
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
import { DEFAULT_MODEL } from '@sumicom/quicksave-shared';
import { StreamCardBuilder, buildCardsFromHistory } from './cardBuilder.js';

/**
 * Events emitted by ClaudeCodeService:
 *   'card-event'           (event: CardEvent)
 *   'card-stream-end'      (result: CardStreamEnd)
 *   'user-input-request'   (request: ClaudeUserInputRequestPayload)
 *   'user-input-resolved'  ({ requestId, sessionId })
 *   'session-updated'      ({ sessionId, isActive, isStreaming, hasPendingInput, permissionMode })
 *   'preferences-updated'  (prefs: ClaudePreferences)
 *   'session-config-updated' ({ sessionId, config: Record<string, ConfigValue> })
 */

type PermissionLevel = 'bypassPermissions' | 'acceptEdits' | 'default' | 'plan';

/** Tools auto-approved at each permission level (no user prompt).
 *  Read/Glob/Grep are always auto-approved at SDK level (allowedTools).
 *  Tools NOT listed here go through canUseTool → permission prompt.
 *
 *  Risk tiers:
 *  - Safe:     Edit, Write, NotebookEdit, TodoWrite, Agent, EnterWorktree, ExitWorktree
 *  - Network:  WebFetch, WebSearch
 *  - Execute:  Bash
 *  - Code/Control: Skill, ToolSearch, Config
 *  - Schedule: CronCreate, CronDelete (arbitrary scheduled execution)
 *  - Remote:   RemoteTrigger (triggers remote agents)
 *  - Workflow:  EnterPlanMode, ExitPlanMode (ExitPlanMode has its own interactive UI)
 */
const AUTO_APPROVE: Record<PermissionLevel, Set<string>> = {
  bypassPermissions: new Set([
    // Safe
    'Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Agent', 'EnterWorktree', 'ExitWorktree',
    // Network
    'WebFetch', 'WebSearch',
    // Execute
    'Bash',
    // Code/Control
    'Skill', 'ToolSearch', 'Config',
    // Schedule + Remote
    'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger',
    // Workflow
    'EnterPlanMode', 'ExitPlanMode',
    // Background tasks
    'TaskOutput', 'TaskStop',
  ]),
  acceptEdits: new Set(['Edit', 'Write', 'NotebookEdit', 'TodoWrite', 'Agent', 'EnterWorktree', 'ExitWorktree']),
  default:     new Set(['TodoWrite', 'EnterWorktree', 'ExitWorktree', 'Agent']),
  plan:        new Set(),
};

interface SessionIdRef {
  current: string | null;
  promise: Promise<string>;
}

interface PersistentSession {
  session: SDKSession;
  sessionId: string;
  sessionIdRef: SessionIdRef;
  cwd: string;
  streaming: boolean;
  permissionLevel: PermissionLevel;
  cardBuilder: StreamCardBuilder | null;
  /** Queued prompts waiting to be processed after current turn completes */
  _promptQueue: Array<{ prompt: string; streamId: string }>;
  /** Set to true to abort the current stream */
  _cancelled: boolean;
  /** True if the turn loop is running (prevents starting duplicate loops) */
  _loopRunning: boolean;
  /** The single stream generator — only call session.stream() once, reuse across turns */
  _streamGenerator: AsyncGenerator<any, void> | null;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Extract readable text from tool_result content (which may be a string or array of blocks). */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text || '')
      .join('\n');
  }
  return JSON.stringify(content);
}

interface PendingUserInput {
  resolve: (response: ClaudeUserInputResponsePayload) => void;
  request: ClaudeUserInputRequestPayload;  // stored for re-send on reconnect
}


export class ClaudeCodeService extends EventEmitter {
  private sessions: Map<string, PersistentSession> = new Map();
  private sessionPermissions: Map<string, PermissionLevel> = new Map(); // persists across active/inactive
  private sessionConfigs: Map<string, Record<string, ConfigValue>> = new Map(); // generic per-session config
  private pendingInputRequests: Map<string, PendingUserInput> = new Map();
  private requestCounter = 0;
  private preferences: ClaudePreferences = {
    model: DEFAULT_MODEL,
  };

  constructor() {
    super();
  }

  /**
   * Initialize preferences from the most recently used session.
   * Uses SDK listSessions + getSessionMessages to read the last assistant message's model field.
   */
  async initPreferences(): Promise<void> {
    try {
      const sessions = await listSessions();
      if (sessions.length === 0) return;

      // Sessions are sorted by lastModified desc by the SDK
      const latest = sessions[0] as any;
      const sessionId: string = latest.sessionId;
      const cwd: string | undefined = latest.cwd;

      const msgs = await getSessionMessages(sessionId, { dir: cwd });
      for (let i = msgs.length - 1; i >= 0; i--) {
        const model = (msgs[i].message as any)?.model;
        if (model && msgs[i].type === 'assistant') {
          this.preferences.model = model;
          break;
        }
      }
    } catch { /* use defaults */ }
  }

  getPreferences(): ClaudePreferences {
    return { ...this.preferences };
  }

  /**
   * Update preferences. Returns the applied preferences (may differ if validation fails).
   * Emits 'preferences-updated' if any value actually changed.
   */
  setPreferences(prefs: Partial<ClaudePreferences>): ClaudePreferences {
    const next = { ...this.preferences };
    let changed = false;

    if (prefs.model !== undefined && prefs.model !== this.preferences.model) {
      next.model = prefs.model;
      changed = true;
    }

    if (changed) {
      this.preferences = next;
      this.emit('preferences-updated', this.preferences);
    }

    return { ...this.preferences };
  }

  getSessionConfig(sessionId: string): Record<string, ConfigValue> {
    return { ...this.sessionConfigs.get(sessionId) };
  }

  /**
   * Set a single key on a session's config. Applies known keys immediately:
   *   model / reasoningEffort → updates global preferences (takes effect next turn)
   *   permissionMode          → calls setPermissionLevel (immediate)
   */
  setSessionConfig(sessionId: string, key: string, value: ConfigValue): Record<string, ConfigValue> {
    const prev = this.sessionConfigs.get(sessionId) ?? {};
    const next = { ...prev, [key]: value };
    this.sessionConfigs.set(sessionId, next);

    // Apply known keys
    if (key === 'model' && typeof value === 'string') {
      this.setPreferences({ model: value });
    } else if (key === 'reasoningEffort' && (typeof value === 'string' || value === null)) {
      this.setPreferences({ reasoningEffort: value as ClaudePreferences['reasoningEffort'] });
    } else if (key === 'permissionMode' && typeof value === 'string') {
      this.setPermissionLevel(sessionId, value as PermissionLevel);
    }

    this.emit('session-config-updated', { sessionId, config: next });
    return next;
  }

  /** Build and emit a session-updated event with current state. */
  private emitSessionUpdate(sessionId: string): void {
    const ps = this.sessions.get(sessionId);
    const hasPendingInput = Array.from(this.pendingInputRequests.values())
      .some((p) => p.request.sessionId === sessionId);
    this.emit('session-updated', {
      sessionId,
      isActive: !!ps,
      isStreaming: ps?.streaming ?? false,
      hasPendingInput,
      permissionMode: ps?.permissionLevel,
    });
  }

  async listAvailableSessions(cwd: string): Promise<ClaudeSessionSummary[]> {
    const sessions = await listSessions({ dir: cwd, limit: 50 });
    // Enrich with live state + detect pending from JSONL
    const pendingSessionIds = new Set(
      Array.from(this.pendingInputRequests.values()).map((p) => p.request.sessionId)
    );
    // Check JSONL for sessions not in memory (cold pending detection)
    const enriched = await Promise.all(sessions.map(async (s) => {
      const isActive = this.sessions.has(s.sessionId);
      const isStreaming = this.sessions.get(s.sessionId)?.streaming ?? false;
      let hasPendingInput = pendingSessionIds.has(s.sessionId);

      // Only check JSONL for sessions NOT in memory — in-memory sessions use
      // pendingInputRequests as the authoritative source. JSONL may have mid-flight
      // tool_use blocks that haven't received tool_result yet (false positive).
      if (!hasPendingInput && !isActive) {
        hasPendingInput = await this.detectPendingFromJSONL(s.sessionId, cwd);
      }

      return {
        sessionId: s.sessionId,
        summary: s.summary,
        lastModified: s.lastModified,
        createdAt: s.createdAt,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        isActive,
        isStreaming,
        hasPendingInput,
        permissionMode: this.sessions.get(s.sessionId)?.permissionLevel ?? this.sessionPermissions.get(s.sessionId),
      };
    }));
    // Sort: pending first, then active, then by lastModified
    enriched.sort((a, b) => {
      if (a.hasPendingInput !== b.hasPendingInput) return a.hasPendingInput ? -1 : 1;
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return b.lastModified - a.lastModified;
    });
    return enriched;
  }

  /**
   * Check if a session's last message is an unanswered tool_use.
   * Uses SDK getSessionMessages + listSubagents/getSubagentMessages.
   */
  private async detectPendingFromJSONL(sessionId: string, cwd: string): Promise<boolean> {
    const hasPendingToolUse = (msgs: any[], label = 'parent'): boolean => {
      if (msgs.length === 0) return false;
      const last = msgs[msgs.length - 1];
      if (last.type !== 'assistant') return false;
      const content = last.message?.content;
      if (!Array.isArray(content)) return false;
      const toolUseIds = content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id as string);
      if (toolUseIds.length === 0) return false;
      // Check if all tool_use blocks already have a corresponding tool_result
      const resolvedIds = new Set<string>(
        msgs
          .filter((m: any) => m.type === 'user')
          .flatMap((m: any) => {
            const c = m.message?.content;
            return Array.isArray(c)
              ? c.filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id as string)
              : [];
          })
      );
      const unresolvedIds = toolUseIds.filter((id: string) => !resolvedIds.has(id));
      if (unresolvedIds.length > 0) {
        const toolNames = content
          .filter((b: any) => b.type === 'tool_use' && unresolvedIds.includes(b.id))
          .map((b: any) => b.name);
        console.log(`[detectPending] ${label} session=${sessionId.slice(0, 8)}: unresolved tool_use: ${toolNames.join(', ')} (${unresolvedIds.length}/${toolUseIds.length})`);
      }
      return unresolvedIds.length > 0;
    };

    try {
      // Check parent session
      const allMessages = await getSessionMessages(sessionId, { dir: cwd });
      if (hasPendingToolUse(allMessages as any[])) return true;

      // Check subagents — a subagent may be waiting for permission
      try {
        const agentIds = await listSubagents(sessionId, { dir: cwd });
        for (const agentId of agentIds) {
          const subMsgs = await getSubagentMessages(sessionId, agentId, { dir: cwd });
          if (hasPendingToolUse(subMsgs as any[], `subagent:${agentId.slice(0, 8)}`)) return true;
        }
      } catch { /* no subagents */ }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Create a V2 session with the given cwd.
   * V2 SDKSessionOptions doesn't expose `cwd`, so we temporarily change
   * process.cwd() around the synchronous createSession() call.
   */
  private createSessionWithCwd(
    cwd: string,
    sessionId: string | null,
    opts: {
      allowedTools?: string[];
      model?: string;
      permissionMode?: string;
      resumeSessionId?: string;
      sessionIdRef?: SessionIdRef;
    }
  ): SDKSession {
    const originalCwd = process.cwd();
    try {
      process.chdir(cwd);
      // allowedTools = SDK auto-approve list (bypasses canUseTool entirely).
      // Only list tools that should NEVER prompt at ANY permission level.
      // Everything else goes through permissionMode → canUseTool for dynamic control.
      const sessionOpts = {
        model: opts.model ?? DEFAULT_MODEL,
        allowedTools: opts.allowedTools ?? ['Read', 'Glob', 'Grep'],
        permissionMode: 'default' as const,
        includePartialMessages: true,
        settingSources: ['user' as const, 'project' as const, 'local' as const],
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
          options: { title?: string; description?: string; displayName?: string; toolUseID: string; agentID?: string; signal: AbortSignal }
        ) => {

          // Resolve session ID: use mutable ref (updated when init arrives),
          // fall back to static closure, await deferred if still unknown.
          let resolvedSessionId = opts.sessionIdRef?.current ?? sessionId;
          if (!resolvedSessionId && opts.sessionIdRef?.promise) {
            resolvedSessionId = await opts.sessionIdRef.promise;
          }
          resolvedSessionId = resolvedSessionId ?? 'unknown';

          // Check runtime permission level — auto-approve if tool is in the allow set
          const ps = resolvedSessionId !== 'unknown' ? this.sessions.get(resolvedSessionId) : undefined;
          const level = ps?.permissionLevel ?? this.sessionPermissions.get(resolvedSessionId) ?? 'acceptEdits';
          if (AUTO_APPROVE[level].has(toolName)) {
            // For file-writing tools, restrict auto-approval to paths inside the project cwd
            const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
            if (FILE_WRITE_TOOLS.has(toolName)) {
              const filePath = (input.file_path ?? input.path) as string | undefined;
              if (filePath) {
                const resolvedFile = resolve(filePath);
                const resolvedCwd = resolve(cwd);
                const inScope = resolvedFile === resolvedCwd || resolvedFile.startsWith(resolvedCwd + '/');
                if (!inScope) {
                  // Fall through to permission prompt below
                } else {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
              } else {
                return { behavior: 'allow' as const, updatedInput: input };
              }
            } else {
              return { behavior: 'allow' as const, updatedInput: input };
            }
          }
          const requestId = `perm-${++this.requestCounter}`;

          // AskUserQuestion: forward as question type with options
          const isQuestion = toolName === 'AskUserQuestion';
          const questions = isQuestion ? (input as any).questions : undefined;


          // Forward request to PWA
          const request: ClaudeUserInputRequestPayload = {
            sessionId: resolvedSessionId,
            requestId,
            inputType: isQuestion ? 'question' : 'permission',
            title: isQuestion
              ? questions?.[0]?.question ?? 'Question from Claude'
              : (options.title ?? `Allow ${toolName}?`),
            message: isQuestion
              ? undefined
              : (options.description ?? JSON.stringify(input).slice(0, 500)),
            toolName,
            toolInput: input,
            toolUseId: options.toolUseID,
            ...(options.agentID ? { agentId: options.agentID } : {}),
            // Include structured options for question type
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

          // Card-based: create/attach pending input on the correct card
          const builder = ps?.cardBuilder;
          if (builder) {
            const pendingAttachment = {
              sessionId: resolvedSessionId,
              requestId,
              inputType: request.inputType,
              title: request.title,
              message: request.message,
              options: request.options,
            };
            // Every permission gets its own ToolCallCard.
            // Subagent permissions are ephemeral — removed after resolution
            // (the tool runs in the sidechain, so no result will arrive).
            const ephemeral = !!options.agentID;
            const cardEvt = builder.toolCallFromPermission(toolName, input, options.toolUseID, pendingAttachment, ephemeral);
            this.emit('card-event', cardEvt);
          }

          this.emit('user-input-request', request);

          // Register pending BEFORE emitting session-updated so hasPendingInput is true
          const responsePromise = this.waitForUserInput(requestId, request, options.signal);
          this.emitSessionUpdate(resolvedSessionId);

          // Wait for explicit user response (no timeout — user must act)
          const response = await responsePromise;
          if (response.action === 'deny') {
            return { behavior: 'deny' as const, message: 'User denied permission' };
          }

          // For AskUserQuestion, inject user's answer into the tool input
          if (isQuestion && response.response) {
            const answers: Record<string, string> = {};
            if (questions?.[0]?.question) {
              answers[questions[0].question] = response.response;
            }
            return {
              behavior: 'allow' as const,
              updatedInput: { ...input, answers },
            };
          }

          return { behavior: 'allow' as const, updatedInput: input };
        },
      };
      if (opts.resumeSessionId) {
        return unstable_v2_resumeSession(opts.resumeSessionId, sessionOpts);
      }
      return unstable_v2_createSession(sessionOpts);
    } finally {
      process.chdir(originalCwd);
    }
  }

  private waitForUserInput(
    requestId: string,
    request: ClaudeUserInputRequestPayload,
    signal?: AbortSignal
  ): Promise<ClaudeUserInputResponsePayload> {
    return new Promise((resolve) => {
      this.pendingInputRequests.set(requestId, { resolve, request });

      // Only auto-resolve if the SDK itself aborts (e.g. session closed)
      signal?.addEventListener('abort', () => {
        this.pendingInputRequests.delete(requestId);
        resolve({ sessionId: '', requestId, action: 'allow' });
      }, { once: true });
    });
  }

  /**
   * Called by message handler when PWA sends a user input response.
   */
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

    this.emit('user-input-resolved', { requestId: response.requestId, sessionId: pending.request.sessionId });
    this.emitSessionUpdate(pending.request.sessionId);
    return true;
  }

  /**
   * Get all pending user input requests (for re-sending to a reconnected client).
   */
  getPendingInputRequests(): ClaudeUserInputRequestPayload[] {
    return Array.from(this.pendingInputRequests.values()).map((p) => p.request);
  }

  /** Debug snapshot of pending inputs and active sessions. */
  getDebugState(): {
    pendingInputs: Array<{ requestId: string; sessionId: string; toolName?: string; agentId?: string; inputType: string }>;
    activeSessions: Array<{ sessionId: string; cwd: string; isStreaming: boolean; hasPendingInput: boolean; permissionMode: string }>;
  } {
    const pendingInputs = Array.from(this.pendingInputRequests.values()).map((p) => ({
      requestId: p.request.requestId,
      sessionId: p.request.sessionId,
      toolName: p.request.toolName,
      agentId: (p.request as any).agentId,
      inputType: p.request.inputType,
    }));
    return { pendingInputs, activeSessions: this.getActiveSessions() };
  }

  async startSession(opts: {
    prompt: string;
    cwd: string;
    streamId: string;
    allowedTools?: string[];
    systemPrompt?: string;
    model?: string;
    permissionMode?: string;
  }): Promise<string> {
    const validModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
    const level: PermissionLevel = validModes.includes(opts.permissionMode as any)
      ? (opts.permissionMode as PermissionLevel) : 'acceptEdits';

    // Mutable ref so canUseTool can access the real sessionId once init arrives
    const deferred = createDeferred<string>();
    const sessionIdRef: SessionIdRef = { current: null, promise: deferred.promise };

    const session = this.createSessionWithCwd(opts.cwd, null, {
      allowedTools: opts.allowedTools,
      model: opts.model,
      permissionMode: opts.permissionMode,
      sessionIdRef,
    });

    const prompt = opts.systemPrompt
      ? `[System context: ${opts.systemPrompt}]\n\n${opts.prompt}`
      : opts.prompt;

    await session.send(prompt);

    // Create the stream generator ONCE — reused by processTurnLoop.
    // IMPORTANT: Do NOT use for-await+break to consume init, because break
    // calls generator.return() which closes the generator permanently.
    const streamGen = session.stream();

    // Pull messages manually until we get the init message
    let sessionId: string | undefined;
    while (!sessionId) {
      const { value: message, done } = await streamGen.next();
      if (done) throw new Error('Stream ended before init message');
      if (message.type === 'system' && (message as any).subtype === 'init') {
        const id = message.session_id;
        sessionIdRef.current = id;
        deferred.resolve(id);
        this.sessionPermissions.set(id, level);
        this.sessions.set(id, {
          session,
          sessionId: id,
          sessionIdRef,
          cwd: opts.cwd,
          streaming: true,
          permissionLevel: level,
          cardBuilder: null,
          _promptQueue: [],
          _cancelled: false,
          _loopRunning: false,
          _streamGenerator: streamGen,
        });
        this.emitSessionUpdate(id);
        sessionId = id;
      }
    }

    // Seed the queue with the initial streamId (prompt already sent via session.send())
    const ps = this.sessions.get(sessionId)!;
    ps._promptQueue.push({ prompt: '', streamId: opts.streamId });

    // Start the turn loop (reuses the same streamGen — picks up remaining messages)
    this.processTurnLoop(sessionId);

    return sessionId;
  }

  async resumeSession(opts: {
    sessionId: string;
    prompt: string;
    cwd: string;
    streamId: string;
  }): Promise<string> {
    const existing = this.sessions.get(opts.sessionId);

    if (existing) {
      // Hot resume — push to queue
      console.log(`[v2] hot resume (enqueue) session=${opts.sessionId}`);
      existing._promptQueue.push({ prompt: opts.prompt, streamId: opts.streamId });
      // If not looping, start the loop
      if (!existing._loopRunning) {
        this.processTurnLoop(opts.sessionId);
      }
      return opts.sessionId;
    }

    // Cold resume: create new session with resumeSessionId
    console.log(`[v2] cold resume session=${opts.sessionId}`);
    const deferred = createDeferred<string>();
    const sessionIdRef: SessionIdRef = { current: opts.sessionId, promise: deferred.promise };
    deferred.resolve(opts.sessionId); // already known for resume

    const restoredLevel = this.sessionPermissions.get(opts.sessionId) ?? 'acceptEdits' as PermissionLevel;

    const session = this.createSessionWithCwd(opts.cwd, opts.sessionId, {
      resumeSessionId: opts.sessionId,
      sessionIdRef,
    });

    await session.send(opts.prompt);

    // Create the stream generator ONCE — reused by processTurnLoop.
    // Use manual .next() to avoid for-await+break closing the generator.
    const streamGen = session.stream();

    let actualSessionId: string | undefined;
    while (!actualSessionId) {
      const { value: message, done } = await streamGen.next();
      if (done) throw new Error('Stream ended before init message');
      if (message.type === 'system' && (message as any).subtype === 'init') {
        const id = message.session_id;
        if (id !== opts.sessionId) {
          console.warn(`[v2] SDK created new session ${id} instead of resuming ${opts.sessionId}`);
        }
        sessionIdRef.current = id;
        this.sessionPermissions.set(id, restoredLevel);
        this.sessions.set(id, {
          session,
          sessionId: id,
          sessionIdRef,
          cwd: opts.cwd,
          streaming: true,
          permissionLevel: restoredLevel,
          cardBuilder: null,
          _promptQueue: [],
          _cancelled: false,
          _loopRunning: false,
          _streamGenerator: streamGen,
        });
        this.emitSessionUpdate(id);
        actualSessionId = id;
      }
    }

    // Seed the queue (prompt already sent)
    const ps = this.sessions.get(actualSessionId)!;
    ps._promptQueue.push({ prompt: '', streamId: opts.streamId });

    // Start the turn loop (reuses same streamGen)
    this.processTurnLoop(actualSessionId);

    return actualSessionId;
  }

  cancelSession(sessionId: string): boolean {
    const ps = this.sessions.get(sessionId);
    if (!ps) return false;
    ps._cancelled = true;
    ps._promptQueue.length = 0; // drain queue
    ps.streaming = false;
    return true;
  }

  setPermissionLevel(sessionId: string, level: PermissionLevel): boolean {
    const ps = this.sessions.get(sessionId);
    if (ps) {
      ps.permissionLevel = level;
    }
    // Persist across active/inactive lifecycle
    this.sessionPermissions.set(sessionId, level);
    // Always broadcast so all clients sync, even for inactive sessions
    this.emit('session-updated', {
      sessionId,
      isActive: !!ps,
      isStreaming: ps?.streaming ?? false,
      hasPendingInput: ps ? Array.from(this.pendingInputRequests.values()).some((p) => p.request.sessionId === sessionId) : false,
      permissionMode: level,
    });
    return true;
  }

  getPermissionLevel(sessionId: string): PermissionLevel {
    return this.sessions.get(sessionId)?.permissionLevel ?? 'acceptEdits';
  }

  getActiveSessions(): { sessionId: string; cwd: string; isStreaming: boolean; hasPendingInput: boolean; permissionMode: string }[] {
    const pendingSessionIds = new Set(
      Array.from(this.pendingInputRequests.values()).map((p) => p.request.sessionId)
    );
    return Array.from(this.sessions.entries()).map(([id, ps]) => ({
      sessionId: id,
      cwd: ps.cwd,
      isStreaming: ps.streaming,
      hasPendingInput: pendingSessionIds.has(id),
      permissionMode: ps.permissionLevel,
    }));
  }

  closeSession(sessionId: string): boolean {
    const ps = this.sessions.get(sessionId);
    if (!ps) return false;
    ps._cancelled = true;
    ps._promptQueue.length = 0;
    ps.session.close();
    this.sessions.delete(sessionId);
    this.emitSessionUpdate(sessionId);
    return true;
  }

  isStreaming(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.streaming ?? false;
  }

  isOpen(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  cleanup(): void {
    // Force-resolve any pending inputs on daemon shutdown
    for (const [requestId, pending] of this.pendingInputRequests) {
      pending.resolve({ sessionId: '', requestId, action: 'allow' });
    }
    this.pendingInputRequests.clear();

    for (const [, ps] of this.sessions) {
      try {
        ps.session.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.sessions.clear();
  }

  /** Get the CardBuilder for a session (if streaming). Used by canUseTool. */
  getCardBuilder(sessionId: string): StreamCardBuilder | null {
    return this.sessions.get(sessionId)?.cardBuilder ?? null;
  }

  /** Get card-based history for a session. */
  async getCards(
    sessionId: string,
    cwd: string,
    offset = 0,
    limit = 50,
  ): Promise<CardHistoryResponse> {
    // Always use JSONL as the source of truth for history.
    // Overlay pendingInput from in-memory state (only matters during permission prompts).
    const result = await buildCardsFromHistory(sessionId, cwd, offset, limit);

    // Attach pendingInput to matching tool cards
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
          if (pending) (card as any).pendingInput = pending;
        }
      }
    }

    return result;
  }

  /**
   * Turn loop: dequeue prompt → send() → consume stream → on result, check queue → repeat.
   * The first entry may have an empty prompt (already sent by startSession/resumeSession).
   */
  private async processTurnLoop(sessionId: string): Promise<void> {
    const ps = this.sessions.get(sessionId);
    if (!ps || ps._loopRunning) return;
    ps._loopRunning = true;

    let textBuffer = '';
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;

    const emitCard = (event: CardEvent) => { this.emit('card-event', event); };

    // Create cardBuilder once, reuse across turns (accumulates all cards)
    if (!ps.cardBuilder) {
      ps.cardBuilder = new StreamCardBuilder(sessionId, '');
    }

    try {
      while (ps._promptQueue.length > 0) {
        const { prompt, streamId } = ps._promptQueue.shift()!;
        ps._cancelled = false;
        ps.streaming = true;

        const cb = ps.cardBuilder!;
        cb.startNewTurn(streamId);
        this.emitSessionUpdate(sessionId);

        // Reset text buffering for this turn
        textBuffer = '';
        if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null; }

        const flushText = () => {
          if (textBuffer) {
            console.log(`[stream] flushText len=${textBuffer.length} session=${sessionId.slice(0,8)}`);
            emitCard(cb.assistantText(textBuffer));
            textBuffer = '';
          }
          if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null; }
        };

        const bufferText = (text: string) => {
          textBuffer += text;
          if (!bufferTimer) { bufferTimer = setTimeout(flushText, 150); }
          if (textBuffer.length > 2048) { flushText(); }
        };

        // Send prompt if non-empty (empty means prompt was already sent before loop started)
        if (prompt) {
          emitCard(cb.userMessage(prompt));
          await ps.session.send(prompt);
          // New turn = new generator (v2 API: one stream() call per send())
          ps._streamGenerator = ps.session.stream();
        }

        // Consume this turn's stream using manual .next() to avoid
        // for-await+break calling generator.return() which kills the stream.
        const gen = ps._streamGenerator;
        if (!gen) {
          console.error(`[stream] no generator for session=${sessionId}`);
          break;
        }
        let turnDone = false;
        try {
          while (!turnDone && !ps._cancelled) {
            const { value: message, done } = await gen.next();
            if (done) { turnDone = true; break; }

            // Subagent lifecycle events
            if (message.type === 'system' && (message as any).subtype === 'task_started') {
              const m = message as any;
              flushText();
              emitCard(cb.subagentStart(m.description ?? '', m.task_id, m.tool_use_id));
              continue;
            }

            if (message.type === 'system' && (message as any).subtype === 'task_progress') {
              const m = message as any;
              const cardEvt = cb.subagentProgress(m.task_id, m.tool_use_id, m.usage?.tool_uses, m.last_tool_name);
              if (cardEvt) emitCard(cardEvt);
              continue;
            }

            if (message.type === 'system' && (message as any).subtype === 'task_notification') {
              const m = message as any;
              const cardEvt = cb.subagentEnd(m.task_id, m.tool_use_id, m.status, m.summary);
              if (cardEvt) emitCard(cardEvt);
              continue;
            }

            // Session state changed — 'idle' means turn is over
            if (message.type === 'system' && (message as any).subtype === 'session_state_changed') {
              const state = (message as any).state;
              if (state === 'idle') {
                flushText();
                console.log(`[stream] session_state_changed=idle session=${sessionId}`);
              }
              continue;
            }

            // Streaming partial events
            if (message.type === 'stream_event') {
              const event = (message as any).event;
              if (event?.type === 'content_block_delta') {
                const delta = event.delta;
                if (delta?.type === 'text_delta' && delta.text) {
                  bufferText(delta.text);
                }
              } else if (!event?.type?.includes('delta')) {
                console.log(`[stream] stream_event type=${event?.type} session=${sessionId.slice(0,8)}`);
              }
              continue;
            }

            // Complete assistant messages — skip sidechain (subagent) messages.
            if (message.type === 'assistant') {
              if ((message as any).agentId) continue; // sidechain message — ignore
              flushText();
              const betaMessage = (message as any).message;
              const blocks = betaMessage?.content ?? [];
              for (const block of blocks) {
                if (block.type === 'thinking' && block.thinking) {
                  emitCard(cb.thinkingBlock(block.thinking));
                } else if (block.type === 'redacted_thinking') {
                  emitCard(cb.thinkingBlock('[Redacted thinking]'));
                } else if (block.type === 'text' && block.text) {
                  emitCard(cb.assistantText(block.text));
                } else if (block.type === 'tool_use') {
                  // Agent tool calls are represented by SubagentCards (via task_started).
                  if (block.name !== 'Agent') {
                    emitCard(cb.toolUse(block.name, block.input ?? {}, block.id));
                  }
                } else if (block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
                  emitCard(cb.toolUse(block.name ?? block.type, block.input ?? {}, block.id ?? ''));
                }
              }
              continue;
            }

            // User messages contain tool results — skip sidechain messages.
            if (message.type === 'user') {
              if ((message as any).agentId) continue; // sidechain message — ignore
              const userMsg = (message as any).message;
              if (userMsg?.content && Array.isArray(userMsg.content)) {
                for (const block of userMsg.content) {
                  if (block.type === 'tool_result') {
                    const resultContent = extractToolResultText(block.content);
                    const cardEvt = cb.toolResult(block.tool_use_id, resultContent, !!block.is_error);
                    if (cardEvt) emitCard(cardEvt);
                  }
                  // Handle server/MCP tool results in streaming
                  if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result' ||
                      block.type === 'mcp_tool_result' || block.type === 'code_execution_tool_result' ||
                      block.type === 'tool_search_tool_result') {
                    const resultContent = extractToolResultText(block.content ?? block.text ?? '');
                    const parentId = block.tool_use_id;
                    if (parentId) {
                      const cardEvt = cb.toolResult(parentId, resultContent, !!block.is_error);
                      if (cardEvt) emitCard(cardEvt);
                    }
                  }
                }
              }
              continue;
            }

            // ── Result — exit this turn's stream, loop will check queue ──
            if (message.type === 'result') {
              if ((message as any).session_id !== sessionId) {
                console.log(`[stream] skip subagent result session=${(message as any).session_id?.slice(0,8)}`);
                continue;
              }
              flushText();
              const result = message as any;
              console.log(`[stream] result session=${sessionId} subtype=${result.subtype} cost=$${result.total_cost_usd?.toFixed(4) ?? '?'}`);

              const streamEnd: CardStreamEnd = {
                streamId,
                sessionId,
                success: result.subtype === 'success',
                error: result.subtype !== 'success'
                  ? (result.errors?.join('; ') || `Session ended: ${result.subtype}`)
                  : undefined,
                totalCostUsd: result.total_cost_usd,
                tokenUsage: result.usage
                  ? { input: result.usage.input_tokens, output: result.usage.output_tokens }
                  : undefined,
              };
              this.emit('card-stream-end', streamEnd);
              turnDone = true; // exit this turn's stream without closing generator
            }
          }
        } catch (error) {
          flushText();
          console.error(`[stream] error session=${sessionId}:`, error);
          const msg = error instanceof Error ? error.message : 'Unknown error';
          this.emit('card-stream-end', { streamId, sessionId, success: false, error: msg });
        }

        // Turn done — finalize text, keep cardBuilder (accumulates across turns)
        const finalizeEvent = cb.finalizeAssistantText();
        if (finalizeEvent) emitCard(finalizeEvent);
        ps.streaming = false;
        this.emitSessionUpdate(sessionId);
      }
    } finally {
      ps._loopRunning = false;
    }
  }
}
