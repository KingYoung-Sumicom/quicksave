# Coding Agent Provider Abstraction

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a `CodingAgentProvider` interface from `CLISessionRunner` so multiple backends (Claude CLI, Claude SDK v1, Codex) can plug in behind the same `SessionManager`.

**Architecture:** Option C — Layered. `CodingAgentProvider` is a thin interface covering process/streaming lifecycle only. `SessionManager` is the shared orchestration layer that owns cards, permissions, config, preferences, events, and session registry. `SessionManager` holds one `CodingAgentProvider` and delegates process operations to it. `messageHandler.ts` and `run.ts` only interact with `SessionManager` (same API as current `CLISessionRunner`).

**Tech Stack:** TypeScript, Node EventEmitter, existing shared types

---

## File Structure

| File | Responsibility |
|------|---------------|
| `apps/agent/src/ai/provider.ts` | **NEW** — `CodingAgentProvider` interface + `ProviderSession` interface + `PermissionLevel` type |
| `apps/agent/src/ai/sessionManager.ts` | **NEW** — `SessionManager` class (extracted from `CLISessionRunner`): preferences, config, permissions, cards, events, session registry |
| `apps/agent/src/ai/claudeCliProvider.ts` | **NEW** — `ClaudeCliProvider` implements `CodingAgentProvider`: CLI spawn, stream-json parsing, control_request handling |
| `apps/agent/src/ai/cliSessionRunner.ts` | **DELETE** — replaced by `sessionManager.ts` + `claudeCliProvider.ts` |
| `apps/agent/src/handlers/messageHandler.ts` | **MODIFY** — import `SessionManager` instead of `CLISessionRunner` |
| `apps/agent/src/service/run.ts` | **MODIFY** — import `SessionManager` instead of `CLISessionRunner` (event names unchanged) |

---

### Task 1: Define `CodingAgentProvider` interface

**Files:**
- Create: `apps/agent/src/ai/provider.ts`

- [ ] **Step 1: Create provider.ts with types and interface**

```typescript
// apps/agent/src/ai/provider.ts
import type { CardEvent, CardStreamEnd } from '@sumicom/quicksave-shared';
import type { StreamCardBuilder } from './cardBuilder.js';

export type PermissionLevel = 'bypassPermissions' | 'acceptEdits' | 'default' | 'plan';

/**
 * Represents a running provider session (process, connection, etc).
 * Provider-specific — SessionManager treats it as opaque.
 */
export interface ProviderSession {
  /** Send a user message to the running session (hot resume). */
  sendUserMessage(prompt: string): void;
  /** Request interruption of the current turn. */
  interrupt(): void;
  /** Kill/close the session process. */
  kill(): void;
  /** True if the process is alive and connected. */
  readonly alive: boolean;
}

/** Callback interface that the provider calls into SessionManager with. */
export interface ProviderCallbacks {
  emitCardEvent(event: CardEvent): void;
  emitStreamEnd(result: CardStreamEnd): void;
  /** Provider detected a tool permission request. Returns the user's decision. */
  handlePermissionRequest(sessionId: string, req: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
  }): Promise<{ action: 'allow' | 'deny'; response?: string; updatedInput?: Record<string, unknown> }>;
  /** Provider detected the model being used (from init event). */
  onModelDetected(model: string): void;
}

export interface StartSessionOpts {
  prompt: string;
  cwd: string;
  streamId: string;
  model?: string;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  systemPrompt?: string;
}

export interface ResumeSessionOpts {
  sessionId: string;
  prompt: string;
  cwd: string;
  streamId: string;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
}

/**
 * Thin interface for coding agent backends.
 * Covers ONLY process/streaming lifecycle.
 * SessionManager handles everything else (cards, permissions, config, events).
 */
export interface CodingAgentProvider {
  /** Spawn a new session. Returns sessionId and the ProviderSession handle. */
  startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }>;

  /** Cold-resume a session (spawn new process for existing sessionId). */
  resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }>;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/agent && npx tsc --noEmit`
Expected: PASS

---

### Task 2: Extract `SessionManager` from `CLISessionRunner`

This is the largest task. `SessionManager` keeps all the shared logic from `CLISessionRunner`:
- `sessions` map, `sessionPermissions`, `sessionSandboxed`, `sessionConfigs`, `pendingInputRequests`
- All public methods: preferences, config, permissions, query, cards, cleanup
- Event emission: card-event, card-stream-end, session-updated, preferences-updated, session-config-updated, user-input-request, user-input-resolved
- `AUTO_APPROVE` table and `shouldAutoApprove` logic
- `persistAllowPattern` logic

The provider-specific code it does NOT include:
- `buildCliArgs`, `spawnAndConsume`, `consumeStream`, `routeMessage`
- `sendControlResponse`, `handleControlRequest` (the CLI-specific stdin/stdout protocol)
- `ChildProcess` management

**Files:**
- Create: `apps/agent/src/ai/sessionManager.ts`
- Reference: `apps/agent/src/ai/cliSessionRunner.ts` (source of truth for extraction)

- [ ] **Step 1: Create sessionManager.ts with the SessionManager class**

The class should:
1. Accept a `CodingAgentProvider` in constructor
2. Store `ProviderSession` handles per sessionId (replacing `ActiveSession.process`)
3. Implement the same public API as `CLISessionRunner` (method signatures unchanged for consumers)
4. Implement `ProviderCallbacks` to bridge provider events to the existing event system

```typescript
// apps/agent/src/ai/sessionManager.ts
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
import { SANDBOX_MCP_PREFIX, SET_TITLE_TOOL } from './sandboxMcp.js';
import { getSessionRegistry } from './sessionRegistry.js';
import type { CodingAgentProvider, ProviderSession, ProviderCallbacks, PermissionLevel } from './provider.js';

/** Tools auto-approved at each permission level. */
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

interface ManagedSession {
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
  private provider: CodingAgentProvider;
  private sessions: Map<string, ManagedSession> = new Map();
  private sessionPermissions: Map<string, PermissionLevel> = new Map();
  private sessionSandboxed: Map<string, boolean> = new Map();
  private sessionConfigs: Map<string, Record<string, ConfigValue>> = new Map();
  private pendingInputRequests: Map<string, PendingUserInput> = new Map();
  private requestCounter = 0;
  private runtimeAllowPatterns: string[] = [];
  private preferences: ClaudePreferences = { model: DEFAULT_MODEL };

  constructor(provider: CodingAgentProvider) {
    super();
    this.provider = provider;
  }

  // ── Provider Callbacks ── (bridge between provider and event system)

  private makeCallbacks(sessionId: string): ProviderCallbacks {
    return {
      emitCardEvent: (event) => this.emit('card-event', event),
      emitStreamEnd: (result) => {
        this.emit('card-stream-end', result);
        const ps = this.sessions.get(sessionId);
        if (ps) {
          ps.streaming = false;
          this.emitSessionUpdate(sessionId);
        }
      },
      handlePermissionRequest: (sid, req) => this.handlePermissionRequest(sid, req),
      onModelDetected: (model) => {
        this.preferences.model = model;
      },
    };
  }

  // ── Preferences ──
  // (identical to CLISessionRunner — copy verbatim)

  async initPreferences(): Promise<void> {}

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
    if (changed) {
      this.preferences = next;
      this.emit('preferences-updated', this.preferences);
    }
    return { ...this.preferences };
  }

  // ── Session Config ──
  // (identical to CLISessionRunner)

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

    const sandboxNote = opts.sandboxed
      ? '[Sandbox mode: ON — use SandboxBash from quicksave-sandbox MCP for shell commands.]'
      : '[Sandbox mode: OFF — SandboxBash is available but disabled.]';
    const systemParts = [sandboxNote, opts.systemPrompt].filter(Boolean).join('\n');
    const prompt = `[System context: ${systemParts}]\n\n${opts.prompt}`;

    const cardBuilder = new StreamCardBuilder('pending', '');
    const callbacks = this.makeCallbacks('pending'); // sessionId not known yet

    const { sessionId, session } = await this.provider.startSession({
      prompt,
      cwd: opts.cwd,
      streamId: opts.streamId,
      model: opts.model,
      permissionLevel: level,
      sandboxed: !!opts.sandboxed,
      systemPrompt: opts.systemPrompt,
    }, cardBuilder, callbacks);

    // Register session
    cardBuilder.updateSessionId(sessionId);
    this.sessionPermissions.set(sessionId, level);
    if (opts.sandboxed) this.sessionSandboxed.set(sessionId, true);

    const prevConfig = this.sessionConfigs.get(sessionId) ?? {};
    this.sessionConfigs.set(sessionId, {
      ...prevConfig,
      model: opts.model ?? DEFAULT_MODEL,
      permissionMode: level,
      sandboxed: !!opts.sandboxed,
    });

    this.sessions.set(sessionId, {
      sessionId,
      providerSession: session,
      cwd: opts.cwd,
      streaming: true,
      permissionLevel: level,
      sandboxed: !!opts.sandboxed,
      cardBuilder,
    });
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
    if (existing?.streaming && existing.providerSession?.alive) {
      // Hot resume
      existing.providerSession.sendUserMessage(opts.prompt);
      return opts.sessionId;
    }

    // Cold resume
    const level = this.sessionPermissions.get(opts.sessionId) ?? 'acceptEdits';
    const sandboxed = this.sessionSandboxed.get(opts.sessionId) ?? false;

    const cardBuilder = existing?.cardBuilder ?? new StreamCardBuilder(opts.sessionId, '');
    const callbacks = this.makeCallbacks(opts.sessionId);

    const { session } = await this.provider.resumeSession({
      sessionId: opts.sessionId,
      prompt: opts.prompt,
      cwd: opts.cwd,
      streamId: opts.streamId,
      permissionLevel: level,
      sandboxed,
    }, cardBuilder, callbacks);

    if (existing) {
      existing.providerSession = session;
      existing.streaming = true;
    } else {
      this.sessions.set(opts.sessionId, {
        sessionId: opts.sessionId,
        providerSession: session,
        cwd: opts.cwd,
        streaming: true,
        permissionLevel: level,
        sandboxed,
        cardBuilder,
      });
    }
    this.emitSessionUpdate(opts.sessionId);

    return opts.sessionId;
  }

  async cancelSession(sessionId: string): Promise<boolean> {
    const ps = this.sessions.get(sessionId);
    if (!ps?.providerSession?.alive) return false;
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

    const ps = this.sessions.get(pending.request.sessionId);
    if (ps?.cardBuilder) {
      const cardEvt = ps.cardBuilder.clearPendingInput(response.requestId);
      if (cardEvt) this.emit('card-event', cardEvt);
    }

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
  // (identical to CLISessionRunner, using ManagedSession instead of ActiveSession)

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
    // Identical to CLISessionRunner.getCards — copy verbatim
    // (uses buildCardsFromHistory, cardBuilder, pendingInputRequests, sessionConfigs)
    const result = await buildCardsFromHistory(sessionId, cwd, offset, limit);
    const ps = this.sessions.get(sessionId);

    if (ps?.cardBuilder) {
      const streamingCards = ps.cardBuilder.getCards();
      if (streamingCards.length > 0) {
        const existingToolUseIds = new Set<string>();
        const existingTexts = new Set<string>();
        for (const c of result.cards) {
          if ((c as any).toolUseId) existingToolUseIds.add((c as any).toolUseId);
          if (c.type === 'assistant_text' || c.type === 'user' || c.type === 'thinking') existingTexts.add(c.text);
        }
        const newCards = streamingCards.filter(c => {
          if ((c as any).toolUseId && existingToolUseIds.has((c as any).toolUseId)) return false;
          if ((c.type === 'assistant_text' || c.type === 'user' || c.type === 'thinking') && existingTexts.has(c.text)) return false;
          return true;
        });
        result.cards.push(...newCards);
        result.total += newCards.length;
      }
    }

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
        ps.providerSession.kill();
        ps.providerSession = null;
      }
    }
    this.sessions.clear();
  }

  // ── Private: Permission handling ──

  private shouldAutoApprove(sessionId: string, toolName: string, input: Record<string, unknown>): boolean {
    if (toolName.startsWith(SANDBOX_MCP_PREFIX)) {
      if (toolName === SET_TITLE_TOOL && input.title) {
        this.updateSessionTitle(sessionId, input.title as string);
      }
      return true;
    }
    const level = this.sessions.get(sessionId)?.permissionLevel
      ?? this.sessionPermissions.get(sessionId) ?? 'acceptEdits';
    if (!AUTO_APPROVE[level].has(toolName)) return false;

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

  /** Called by provider when a tool permission is needed. */
  private async handlePermissionRequest(
    sessionId: string,
    req: { toolName: string; toolInput: Record<string, unknown>; toolUseId: string },
  ): Promise<{ action: 'allow' | 'deny'; response?: string; updatedInput?: Record<string, unknown> }> {
    // Auto-approve check
    if (this.shouldAutoApprove(sessionId, req.toolName, req.toolInput)) {
      return { action: 'allow' };
    }
    if (this.runtimeAllowPatterns.some(p => matchAllowPattern(p, req.toolName, req.toolInput))) {
      return { action: 'allow' };
    }

    // Forward to PWA
    const requestId = `perm-${++this.requestCounter}`;
    const isQuestion = req.toolName === 'AskUserQuestion';
    const questions = isQuestion ? (req.toolInput as any).questions : undefined;

    const request: ClaudeUserInputRequestPayload = {
      sessionId,
      requestId,
      inputType: isQuestion ? 'question' : 'permission',
      title: isQuestion
        ? questions?.[0]?.question ?? 'Question from Claude'
        : `Allow ${req.toolName}?`,
      message: isQuestion ? undefined : JSON.stringify(req.toolInput).slice(0, 500),
      toolName: req.toolName,
      toolInput: req.toolInput,
      toolUseId: req.toolUseId,
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
    if (ps?.cardBuilder) {
      const pendingAttachment = {
        sessionId,
        requestId,
        inputType: request.inputType,
        title: request.title,
        message: request.message,
        options: request.options,
      };
      const cardEvt = ps.cardBuilder.toolCallFromPermission(req.toolName, req.toolInput, req.toolUseId, pendingAttachment);
      this.emit('card-event', cardEvt);
    }

    this.emit('user-input-request', request);

    // Wait for user response
    const response = await new Promise<ClaudeUserInputResponsePayload>((resolve) => {
      this.pendingInputRequests.set(requestId, { resolve, request });
    });

    if (response.action === 'deny') {
      return { action: 'deny', response: response.response || 'User denied permission' };
    }

    if (isQuestion && response.response && questions?.[0]?.question) {
      const answers: Record<string, string> = { [questions[0].question]: response.response };
      return { action: 'allow', updatedInput: { ...req.toolInput, answers } };
    }

    return { action: 'allow' };
  }

  // ── Private: Helpers ──

  private updateSessionTitle(sessionId: string, title: string): void {
    const config = this.sessionConfigs.get(sessionId) ?? {};
    this.sessionConfigs.set(sessionId, { ...config, title });
    this.emit('session-config-updated', { sessionId, config: this.sessionConfigs.get(sessionId) });
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
    } catch {}
    const permissions = settings.permissions as Record<string, unknown> ?? {};
    const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
    if (!allow.includes(pattern)) {
      allow.push(pattern);
      settings.permissions = { ...permissions, allow };
      await mkdir(join(cwd, '.claude'), { recursive: true });
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/agent && npx tsc --noEmit`
Expected: PASS

---

### Task 3: Extract `ClaudeCliProvider` from `CLISessionRunner`

Move CLI-specific logic into the provider: `buildCliArgs`, `spawnAndConsume`, `consumeStream`, `routeMessage`, `handleControlRequest`, `sendControlResponse`.

**Files:**
- Create: `apps/agent/src/ai/claudeCliProvider.ts`

- [ ] **Step 1: Create claudeCliProvider.ts**

The provider implements `CodingAgentProvider`. Key differences from `CLISessionRunner`:
- `startSession` returns `{ sessionId, session: CliProviderSession }` instead of just sessionId
- `consumeStream` calls `callbacks.emitCardEvent` and `callbacks.emitStreamEnd` instead of `this.emit`
- `handleControlRequest` calls `callbacks.handlePermissionRequest` instead of managing pendingInputRequests directly
- `CliProviderSession` wraps `ChildProcess` and implements `ProviderSession`

```typescript
// apps/agent/src/ai/claudeCliProvider.ts
import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import type { CardEvent, CardStreamEnd } from '@sumicom/quicksave-shared';
import { StreamCardBuilder } from './cardBuilder.js';
import { SANDBOX_MCP_NAME } from './sandboxMcp.js';
import type {
  CodingAgentProvider,
  ProviderSession,
  ProviderCallbacks,
  StartSessionOpts,
  ResumeSessionOpts,
  PermissionLevel,
} from './provider.js';

const __ownDir = dirname(fileURLToPath(import.meta.url));

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('\n');
  }
  return JSON.stringify(content);
}

class CliProviderSession implements ProviderSession {
  constructor(public process: ChildProcess | null) {}

  get alive(): boolean { return !!this.process && !this.process.killed; }

  sendUserMessage(prompt: string): void {
    if (!this.process?.stdin) throw new Error('Process not alive');
    this.process.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
    }) + '\n');
  }

  interrupt(): void {
    if (!this.process?.stdin) return;
    try {
      this.process.stdin.write(JSON.stringify({
        type: 'control_request',
        request_id: crypto.randomUUID(),
        request: { subtype: 'interrupt' },
      }) + '\n');
    } catch {
      this.process?.kill('SIGTERM');
    }
  }

  kill(): void {
    if (this.process) {
      try { this.process.kill('SIGTERM'); } catch {}
      this.process = null;
    }
  }
}

export class ClaudeCliProvider implements CodingAgentProvider {

  async startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const args = this.buildCliArgs({
      prompt: opts.prompt,
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionLevel,
      sandboxed: opts.sandboxed,
    });

    return this.spawnAndConsume(args, opts.cwd, opts.streamId, opts.prompt, cardBuilder, callbacks);
  }

  async resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const args = this.buildCliArgs({
      prompt: opts.prompt,
      cwd: opts.cwd,
      permissionMode: opts.permissionLevel,
      sandboxed: opts.sandboxed,
      resumeSessionId: opts.sessionId,
    });

    return this.spawnAndConsume(args, opts.cwd, opts.streamId, opts.prompt, cardBuilder, callbacks);
  }

  // ── Private: CLI Args ──
  // (moved from CLISessionRunner.buildCliArgs — identical logic)

  private buildCliArgs(opts: {
    prompt: string;
    cwd: string;
    model?: string;
    permissionMode?: PermissionLevel;
    sandboxed?: boolean;
    resumeSessionId?: string;
  }): string[] {
    const args: string[] = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--verbose',
      '-p', '',
    ];
    if (opts.model) args.push('--model', opts.model);
    if (opts.permissionMode) {
      args.push('--permission-mode', opts.permissionMode);
    }
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }
    // Always inject sandbox MCP server
    const tsPath = join(__ownDir, 'sandboxMcpStdio.ts');
    const jsPath = join(__ownDir, 'sandboxMcpStdio.js');
    const hasTsPath = existsSync(tsPath);
    const mcpConfig = {
      mcpServers: {
        [SANDBOX_MCP_NAME]: {
          type: 'stdio',
          command: hasTsPath ? 'npx' : 'node',
          args: hasTsPath
            ? ['tsx', tsPath, '--cwd', opts.cwd]
            : [jsPath, '--cwd', opts.cwd],
        },
      },
    };
    args.push('--mcp-config', JSON.stringify(mcpConfig));
    return args;
  }

  // ── Private: Spawn & Consume ──
  // (moved from CLISessionRunner — callbacks replace this.emit)

  private async spawnAndConsume(
    args: string[],
    cwd: string,
    streamId: string,
    prompt: string,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    const cliSession = new CliProviderSession(proc);

    proc.stdin!.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
    }) + '\n');

    const bufferedLines: string[] = [];
    const rl = createInterface({ input: proc.stdout! });
    proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[cli:stderr] ${text}`);
    });

    const sessionId = await new Promise<string>((resolveInit, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for init')), 30_000);
      const onLine = (line: string) => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
            clearTimeout(timeout);
            rl.removeListener('line', onLine);
            if (msg.model) callbacks.onModelDetected(msg.model);
            resolveInit(msg.session_id);
          } else {
            bufferedLines.push(line);
          }
        } catch {}
      };
      rl.on('line', onLine);
      proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
      proc.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`claude exited with code ${code} before init`)); });
    });

    // Fire and forget the stream consumer
    this.consumeStream(sessionId, streamId, rl, bufferedLines, cliSession, cardBuilder, callbacks);

    return { sessionId, session: cliSession };
  }

  // ── Private: Stream Consumer ──
  // (moved from CLISessionRunner — uses callbacks)

  private async consumeStream(
    sessionId: string,
    streamId: string,
    rl: ReturnType<typeof createInterface>,
    bufferedLines: string[],
    cliSession: CliProviderSession,
    cb: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<void> {
    let textBuffer = '';
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;

    const emitCard = (event: CardEvent) => callbacks.emitCardEvent(event);
    cb.startNewTurn(streamId);

    const flushText = () => {
      if (textBuffer) {
        emitCard(cb.assistantText(textBuffer));
        textBuffer = '';
      }
      if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null; }
    };

    const bufferText = (text: string) => {
      textBuffer += text;
      if (!bufferTimer) bufferTimer = setTimeout(flushText, 150);
      if (textBuffer.length > 2048) flushText();
    };

    const processLine = async (line: string) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      await this.routeMessage(sessionId, streamId, msg, cliSession, cb, callbacks, emitCard, flushText, bufferText);
    };

    try {
      for (const line of bufferedLines) await processLine(line);
      for await (const line of rl) await processLine(line);
    } catch (error) {
      flushText();
      const msg = error instanceof Error ? error.message : 'Unknown error';
      callbacks.emitStreamEnd({ streamId, sessionId, success: false, error: msg });
    } finally {
      if (bufferTimer) clearTimeout(bufferTimer);
      cliSession.process = null;
      callbacks.emitStreamEnd({
        streamId,
        sessionId,
        success: true,  // Note: result message may have already emitted stream-end
      });
    }
  }

  // ── Private: Route a single stream-json message ──
  // (moved from CLISessionRunner.routeMessage)

  private async routeMessage(
    sessionId: string,
    streamId: string,
    msg: any,
    cliSession: CliProviderSession,
    cb: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    emitCard: (event: CardEvent) => void,
    flushText: () => void,
    bufferText: (text: string) => void,
  ): Promise<void> {
    // Control requests
    if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
      await this.handleControlRequest(sessionId, msg, cliSession, cb, callbacks, emitCard);
      return;
    }
    if (msg.type === 'control_response' || msg.type === 'control_cancel_request') return;

    // System events
    if (msg.type === 'system') {
      if (msg.subtype === 'task_started') {
        flushText();
        emitCard(cb.subagentStart(msg.description ?? '', msg.task_id, msg.tool_use_id));
      } else if (msg.subtype === 'task_progress') {
        const cardEvt = cb.subagentProgress(msg.task_id, msg.tool_use_id, msg.usage?.tool_uses, msg.last_tool_name);
        if (cardEvt) emitCard(cardEvt);
      } else if (msg.subtype === 'task_notification') {
        const cardEvt = cb.subagentEnd(msg.task_id, msg.tool_use_id, msg.status, msg.summary);
        if (cardEvt) emitCard(cardEvt);
      }
      return;
    }

    // Streaming partial events
    if (msg.type === 'stream_event') {
      const event = msg.event;
      if (event?.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          bufferText(delta.text);
        }
      }
      return;
    }

    if (msg.type === 'rate_limit_event') return;

    // Complete assistant messages
    if (msg.type === 'assistant') {
      if (msg.agentId) return;
      flushText();
      const blocks = msg.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'thinking' && block.thinking) {
          emitCard(cb.thinkingBlock(block.thinking));
        } else if (block.type === 'redacted_thinking') {
          emitCard(cb.thinkingBlock('[Redacted thinking]'));
        } else if (block.type === 'text' && block.text) {
          const finalizeEvt = cb.finalizeAssistantText();
          if (finalizeEvt) {
            emitCard(finalizeEvt);
          } else {
            emitCard(cb.assistantText(block.text));
          }
        } else if (block.type === 'tool_use') {
          if (block.name !== 'Agent') {
            emitCard(cb.toolUse(block.name, block.input ?? {}, block.id));
          }
        } else if (block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
          emitCard(cb.toolUse(block.name ?? block.type, block.input ?? {}, block.id ?? ''));
        }
      }
      return;
    }

    // User messages (tool results)
    if (msg.type === 'user') {
      if (msg.agentId) return;
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const resultContent = extractToolResultText(block.content);
            const cardEvt = cb.toolResult(block.tool_use_id, resultContent, !!block.is_error);
            if (cardEvt) emitCard(cardEvt);
          }
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
      return;
    }

    // Result
    if (msg.type === 'result') {
      if (msg.session_id !== sessionId) return;
      flushText();
      const terminalReason: string | undefined = msg.terminal_reason;
      const interrupted = terminalReason === 'aborted_tools' || terminalReason === 'aborted_streaming';

      if (interrupted) emitCard(cb.systemMessage('User interrupted'));

      const finalizeEvent = cb.finalizeAssistantText();
      if (finalizeEvent) emitCard(finalizeEvent);

      callbacks.emitStreamEnd({
        streamId,
        sessionId,
        success: msg.subtype === 'success' && !interrupted,
        error: (msg.subtype !== 'success' && !interrupted)
          ? (msg.errors?.join('; ') || `Session ended: ${msg.subtype}`)
          : undefined,
        interrupted,
        totalCostUsd: msg.total_cost_usd,
        tokenUsage: msg.usage
          ? { input: msg.usage.input_tokens, output: msg.usage.output_tokens }
          : undefined,
      });
    }
  }

  // ── Private: Permission via control_request ──

  private async handleControlRequest(
    sessionId: string,
    msg: any,
    cliSession: CliProviderSession,
    cb: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    emitCard: (event: CardEvent) => void,
  ): Promise<void> {
    if (!cliSession.process) return;
    const req = msg.request;
    const controlRequestId = msg.request_id;
    const toolName = req.tool_name ?? 'Unknown';
    const toolInput = req.input ?? {};
    const toolUseId = req.tool_use_id ?? '';

    const decision = await callbacks.handlePermissionRequest(sessionId, { toolName, toolInput, toolUseId });

    if (decision.action === 'deny') {
      this.sendControlResponse(cliSession.process, controlRequestId, {
        behavior: 'deny',
        message: decision.response || 'User denied permission',
      });
    } else {
      this.sendControlResponse(cliSession.process, controlRequestId, {
        behavior: 'allow',
        updatedInput: decision.updatedInput,
      });
    }
  }

  private sendControlResponse(
    proc: ChildProcess,
    controlRequestId: string,
    result: { behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string },
  ): void {
    const safeResult = result.behavior === 'allow'
      ? { ...result, updatedInput: result.updatedInput ?? {} }
      : result;
    try {
      proc.stdin!.write(JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: controlRequestId,
          response: safeResult,
        },
      }) + '\n');
    } catch (err) {
      console.error(`[cli] failed to send control_response:`, err);
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/agent && npx tsc --noEmit`
Expected: PASS

---

### Task 4: Wire up `messageHandler.ts` and `run.ts`

**Files:**
- Modify: `apps/agent/src/handlers/messageHandler.ts:108`
- Modify: `apps/agent/src/service/run.ts` (import path only)

- [ ] **Step 1: Update messageHandler.ts import and instantiation**

Change:
```typescript
// Before
import { CLISessionRunner } from '../ai/cliSessionRunner.js';
private claudeService: CLISessionRunner = new CLISessionRunner();

// After
import { SessionManager } from '../ai/sessionManager.js';
import { ClaudeCliProvider } from '../ai/claudeCliProvider.js';
private claudeService: SessionManager = new SessionManager(new ClaudeCliProvider());
```

No other changes needed — `SessionManager` exposes the same public API.

- [ ] **Step 2: Update run.ts import**

Change the import and `getClaudeService()` return type from `CLISessionRunner` to `SessionManager`.

- [ ] **Step 3: Delete cliSessionRunner.ts**

Remove `apps/agent/src/ai/cliSessionRunner.ts`.

- [ ] **Step 4: Verify compilation and tests**

Run: `cd apps/agent && npx tsc --noEmit && npx vitest run`
Expected: PASS (all 98 tests)

---

### Task 5: Update messageHandler tests

The existing `messageHandler.test.ts` (30 tests) may mock or reference `CLISessionRunner`. Update references to `SessionManager`.

**Files:**
- Modify: `apps/agent/src/handlers/messageHandler.test.ts`

- [ ] **Step 1: Update import references in test file**

Search and replace `CLISessionRunner` → `SessionManager` in the test file. If tests mock the service, update the mock to use the new import path.

- [ ] **Step 2: Run tests**

Run: `cd apps/agent && npx vitest run`
Expected: All 98 tests PASS

---

### Task 6: Update architecture documentation

**Files:**
- Modify: `docs/references/quicksave-architecture.en.md`

- [ ] **Step 1: Update the AI provider section**

Document the new layered architecture:
- `CodingAgentProvider` interface
- `SessionManager` orchestration layer
- `ClaudeCliProvider` as the default backend
- How to add a new provider (implement interface, pass to SessionManager constructor)

---

## Known Edge Cases

1. **consumeStream `finally` block**: The current `consumeStream` emits `emitStreamEnd` in `finally`, but the `result` message handler also calls `emitStreamEnd`. Need to ensure only one fires (use a `resultEmitted` flag).

2. **makeCallbacks sessionId**: For `startSession`, the sessionId isn't known when callbacks are created. The `makeCallbacks('pending')` approach works because `handlePermissionRequest` receives `sessionId` as a parameter. The `emitStreamEnd` callback captures `sessionId` via closure — update it after init.

3. **Hot resume in SessionManager**: Currently checks `providerSession.alive` instead of `process` directly. The `CliProviderSession.alive` getter checks `!process.killed` which should be equivalent.
