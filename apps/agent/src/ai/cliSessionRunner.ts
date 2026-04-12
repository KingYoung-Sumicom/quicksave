import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { resolve, join, dirname } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
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
import { SANDBOX_MCP_NAME, SANDBOX_MCP_PREFIX, SET_TITLE_TOOL } from './sandboxMcp.js';
import { getSessionRegistry } from './sessionRegistry.js';

/**
 * Events emitted (same as ClaudeCodeService):
 *   'card-event'           (event: CardEvent)
 *   'card-stream-end'      (result: CardStreamEnd)
 *   'user-input-request'   (request: ClaudeUserInputRequestPayload)
 *   'user-input-resolved'  ({ requestId, sessionId })
 *   'session-updated'      ({ sessionId, isActive, isStreaming, hasPendingInput, permissionMode })
 *   'preferences-updated'  (prefs: ClaudePreferences)
 *   'session-config-updated' ({ sessionId, config: Record<string, ConfigValue> })
 */

type PermissionLevel = 'bypassPermissions' | 'acceptEdits' | 'default' | 'plan';

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

interface ActiveSession {
  sessionId: string;
  process: ChildProcess | null;  // null = between turns
  cwd: string;
  streaming: boolean;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  cardBuilder: StreamCardBuilder | null;
  /** pending control_request IDs → resolve/reject for stdin response */
  pendingControlRequests: Map<string, {
    requestId: string;  // our perm-N ID
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
  }>;
}

/** Extract readable text from tool_result content. */
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

const __ownDir = dirname(fileURLToPath(import.meta.url));

interface PendingUserInput {
  resolve: (response: ClaudeUserInputResponsePayload) => void;
  request: ClaudeUserInputRequestPayload;
}


export class CLISessionRunner extends EventEmitter {
  private sessions: Map<string, ActiveSession> = new Map();
  private sessionPermissions: Map<string, PermissionLevel> = new Map();
  private sessionSandboxed: Map<string, boolean> = new Map();
  private sessionConfigs: Map<string, Record<string, ConfigValue>> = new Map();
  private pendingInputRequests: Map<string, PendingUserInput> = new Map();
  private requestCounter = 0;
  private runtimeAllowPatterns: string[] = [];
  private preferences: ClaudePreferences = { model: DEFAULT_MODEL };

  constructor() {
    super();
  }

  // ── Preferences ──

  async initPreferences(): Promise<void> {
    // With CLI wrapper, we just use DEFAULT_MODEL on start.
    // The model is tracked from the last session's init event.
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

    const sandboxNote = opts.sandboxed
      ? '[Sandbox mode: ON — use SandboxBash from quicksave-sandbox MCP for shell commands.]'
      : '[Sandbox mode: OFF — SandboxBash is available but disabled.]';
    const systemParts = [sandboxNote, opts.systemPrompt].filter(Boolean).join('\n');
    const prompt = `[System context: ${systemParts}]\n\n${opts.prompt}`;

    const args = this.buildCliArgs({
      prompt,
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: level,
      sandboxed: opts.sandboxed,
    });

    return this.spawnAndConsume(args, opts.cwd, opts.streamId, level, !!opts.sandboxed, prompt, opts.model);
  }

  async resumeSession(opts: {
    sessionId: string;
    prompt: string;
    cwd: string;
    streamId: string;
  }): Promise<string> {
    const existing = this.sessions.get(opts.sessionId);
    if (existing?.streaming && existing.process) {
      // Hot resume: send user message via stdin to the running process
      console.log(`[cli] hot resume session=${opts.sessionId.slice(0, 8)} streaming=true`);
      const userMsg = {
        type: 'user',
        message: { role: 'user', content: opts.prompt },
      };
      existing.process.stdin!.write(JSON.stringify(userMsg) + '\n');
      return opts.sessionId;
    }

    // Cold resume: spawn new process with --resume
    console.log(`[cli] cold resume session=${opts.sessionId.slice(0, 8)}`);
    const level = this.sessionPermissions.get(opts.sessionId) ?? 'acceptEdits';
    const sandboxed = this.sessionSandboxed.get(opts.sessionId) ?? false;

    const args = this.buildCliArgs({
      prompt: opts.prompt,
      cwd: opts.cwd,
      permissionMode: level,
      sandboxed,
      resumeSessionId: opts.sessionId,
    });

    return this.spawnAndConsume(args, opts.cwd, opts.streamId, level, sandboxed, opts.prompt);
  }

  async cancelSession(sessionId: string): Promise<boolean> {
    const ps = this.sessions.get(sessionId);
    if (!ps?.process) return false;
    console.log(`[cli] cancel session=${sessionId.slice(0, 8)}`);

    // Send interrupt via stdin control_request
    try {
      const interruptReq = {
        type: 'control_request',
        request_id: crypto.randomUUID(),
        request: { subtype: 'interrupt' },
      };
      ps.process.stdin!.write(JSON.stringify(interruptReq) + '\n');
    } catch {
      // If stdin write fails, kill the process
      ps.process.kill('SIGTERM');
    }
    return true;
  }

  closeSession(sessionId: string): boolean {
    const ps = this.sessions.get(sessionId);
    if (!ps) return false;
    if (ps.process) {
      ps.process.kill('SIGTERM');
      ps.process = null;
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

  /** Update session title (triggered by SetTitle MCP tool). */
  private updateSessionTitle(sessionId: string, title: string): void {
    // Update in-memory session summary
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
    const result = await buildCardsFromHistory(sessionId, cwd, offset, limit);
    const ps = this.sessions.get(sessionId);

    // For active streaming sessions, append in-memory cards from cardBuilder.
    // These include the current turn's streaming text, tool calls, and pending
    // permission cards that aren't in the JSONL yet.
    if (ps?.cardBuilder) {
      const streamingCards = ps.cardBuilder.getCards();
      if (streamingCards.length > 0) {
        // Deduplicate by toolUseId (tool_call / subagent cards) and by text
        // content (assistant_text). JSONL cards use "sessionId:h:N" IDs while
        // cardBuilder uses "sessionId:N", so ID comparison alone won't work.
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

    // Overlay pending inputs from pendingInputRequests onto any matching cards.
    // This covers reconnection: even if cardBuilder is gone, pending requests
    // can be attached to JSONL-based tool_call cards by toolUseId.
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
      if (ps.process) {
        try { ps.process.kill('SIGTERM'); } catch {}
        ps.process = null;
      }
    }
    this.sessions.clear();
  }

  // ── Private: CLI Args ──

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
      '-p', '',  // empty print flag — prompt sent via stdin
    ];

    if (opts.model) {
      args.push('--model', opts.model);
    }

    if (opts.permissionMode) {
      const cliMode = opts.permissionMode === 'bypassPermissions' ? 'bypassPermissions'
        : opts.permissionMode === 'acceptEdits' ? 'acceptEdits'
        : opts.permissionMode === 'plan' ? 'plan'
        : 'default';
      args.push('--permission-mode', cliMode);
    }

    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }

    // Always inject sandbox MCP server — approve/deny controlled by sandboxed flag at runtime
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

  private async spawnAndConsume(
    args: string[],
    cwd: string,
    streamId: string,
    level: PermissionLevel,
    sandboxed: boolean,
    prompt: string,
    model?: string,
  ): Promise<string> {
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Send user message immediately — CLI needs stdin before emitting init
    const userMsg = {
      type: 'user',
      message: { role: 'user', content: prompt },
    };
    proc.stdin!.write(JSON.stringify(userMsg) + '\n');

    // Buffer all stdout lines until init is received, then replay them into consumeStream.
    const bufferedLines: string[] = [];
    const rl = createInterface({ input: proc.stdout! });

    // Log stderr for debugging
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

            if (msg.model) {
              this.preferences.model = msg.model;
            }

            resolveInit(msg.session_id);
          } else {
            bufferedLines.push(line);
          }
        } catch {
          // skip non-JSON
        }
      };

      rl.on('line', onLine);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`claude exited with code ${code} before init`));
      });
    });

    // Register session
    this.sessionPermissions.set(sessionId, level);
    if (sandboxed) this.sessionSandboxed.set(sessionId, true);

    const prevConfig = this.sessionConfigs.get(sessionId) ?? {};
    this.sessionConfigs.set(sessionId, {
      ...prevConfig,
      model: model ?? DEFAULT_MODEL,
      permissionMode: level,
      sandboxed,
    });

    const session: ActiveSession = {
      sessionId,
      process: proc,
      cwd,
      streaming: true,
      permissionLevel: level,
      sandboxed,
      cardBuilder: null,
      pendingControlRequests: new Map(),
    };
    this.sessions.set(sessionId, session);
    this.emitSessionUpdate(sessionId);

    // Fire and forget the stream consumer — pass the same readline interface
    this.consumeStream(sessionId, streamId, rl, bufferedLines);

    return sessionId;
  }

  // ── Private: Stream Consumer ──

  private async consumeStream(
    sessionId: string,
    streamId: string,
    rl: ReturnType<typeof createInterface>,
    bufferedLines: string[] = [],
  ): Promise<void> {
    const ps = this.sessions.get(sessionId);
    if (!ps?.process) return;

    let textBuffer = '';
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;

    const emitCard = (event: CardEvent) => { this.emit('card-event', event); };

    if (!ps.cardBuilder) {
      ps.cardBuilder = new StreamCardBuilder(sessionId, '');
    }
    const cb = ps.cardBuilder;
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
      if (!bufferTimer) { bufferTimer = setTimeout(flushText, 150); }
      if (textBuffer.length > 2048) { flushText(); }
    };

    const processLine = async (line: string) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      await this.routeMessage(sessionId, streamId, msg, ps, cb, emitCard, flushText, bufferText);
    };

    try {
      // Replay lines buffered during init
      for (const line of bufferedLines) {
        await processLine(line);
      }

      for await (const line of rl) {
        await processLine(line);
      }
    } catch (error) {
      flushText();
      console.error(`[cli] stream error session=${sessionId.slice(0, 8)}:`, error);
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.emit('card-stream-end', { streamId, sessionId, success: false, error: msg });
    } finally {
      if (bufferTimer) clearTimeout(bufferTimer);
      // Process exited — clean up
      const session = this.sessions.get(sessionId);
      if (session) {
        session.process = null;
        session.streaming = false;
        // Don't delete the session — it persists between turns (cardBuilder reused)
        this.emitSessionUpdate(sessionId);
      }
    }
  }

  // ── Private: Route a single stream-json message ──

  private async routeMessage(
    sessionId: string,
    streamId: string,
    msg: any,
    ps: ActiveSession,
    cb: StreamCardBuilder,
    emitCard: (event: CardEvent) => void,
    flushText: () => void,
    bufferText: (text: string) => void,
  ): Promise<void> {
    // ── Control requests (permissions) ──
    if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
      await this.handleControlRequest(sessionId, msg);
      return;
    }

    // Skip control echoes
    if (msg.type === 'control_response' || msg.type === 'control_cancel_request') return;

    // ── System events ──
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

    // ── Streaming partial events ──
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

    // ── Rate limit events ──
    if (msg.type === 'rate_limit_event') return;

    // ── Complete assistant messages ──
    if (msg.type === 'assistant') {
      if (msg.agentId) return;  // sidechain
      flushText();
      const blocks = msg.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'thinking' && block.thinking) {
          emitCard(cb.thinkingBlock(block.thinking));
        } else if (block.type === 'redacted_thinking') {
          emitCard(cb.thinkingBlock('[Redacted thinking]'));
        } else if (block.type === 'text' && block.text) {
          // If text was already streamed via stream_event deltas, finalize
          // the existing card instead of doubling the content.
          const finalizeEvt = cb.finalizeAssistantText();
          if (finalizeEvt) {
            emitCard(finalizeEvt);
          } else {
            // No active streaming card — emit text normally (e.g. no stream_events preceded this)
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

    // ── User messages (tool results) ──
    if (msg.type === 'user') {
      if (msg.agentId) return;  // sidechain
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

    // ── Result ──
    if (msg.type === 'result') {
      if (msg.session_id !== sessionId) return;  // subagent result
      flushText();
      const terminalReason: string | undefined = msg.terminal_reason;
      const interrupted = terminalReason === 'aborted_tools' || terminalReason === 'aborted_streaming';
      console.log(`[cli] result session=${sessionId.slice(0, 8)} subtype=${msg.subtype} cost=$${msg.total_cost_usd?.toFixed(4) ?? '?'}`);

      if (interrupted) {
        emitCard(cb.systemMessage('User interrupted'));
      }

      const finalizeEvent = cb.finalizeAssistantText();
      if (finalizeEvent) emitCard(finalizeEvent);

      const streamEnd: CardStreamEnd = {
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
      };
      this.emit('card-stream-end', streamEnd);

      ps.streaming = false;
      this.emitSessionUpdate(sessionId);
    }
  }

  // ── Private: Permission Handling via control_request ──

  private async handleControlRequest(sessionId: string, msg: any): Promise<void> {
    const ps = this.sessions.get(sessionId);
    if (!ps?.process) return;

    const req = msg.request;
    const controlRequestId = msg.request_id;
    const toolName = req.tool_name ?? 'Unknown';
    const toolInput = req.input ?? {};
    const toolUseId = req.tool_use_id ?? '';

    // Check our own auto-approve rules first
    if (this.shouldAutoApprove(sessionId, toolName, toolInput)) {
      this.sendControlResponse(ps.process, controlRequestId, { behavior: 'allow' });
      return;
    }

    // Check runtime allow patterns
    if (this.runtimeAllowPatterns.some(p => matchAllowPattern(p, toolName, toolInput))) {
      this.sendControlResponse(ps.process, controlRequestId, { behavior: 'allow' });
      return;
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
    const cb = ps.cardBuilder;
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

    // Store mapping: our requestId → CLI controlRequestId
    ps.pendingControlRequests.set(requestId, {
      requestId: controlRequestId,
      toolName,
      toolInput,
      toolUseId,
    });

    // Wait for user response
    const response = await this.waitForUserInput(requestId, request);

    // Clean up mapping
    ps.pendingControlRequests.delete(requestId);

    if (response.action === 'deny') {
      this.sendControlResponse(ps.process, controlRequestId, {
        behavior: 'deny',
        message: response.response || 'User denied permission',
      });
    } else {
      // For AskUserQuestion, inject answer
      if (isQuestion && response.response) {
        const answers: Record<string, string> = {};
        if (questions?.[0]?.question) {
          answers[questions[0].question] = response.response;
        }
        this.sendControlResponse(ps.process, controlRequestId, {
          behavior: 'allow',
          updatedInput: { ...toolInput, answers },
        });
      } else {
        this.sendControlResponse(ps.process, controlRequestId, { behavior: 'allow' });
      }
    }
  }

  private shouldAutoApprove(sessionId: string, toolName: string, input: Record<string, unknown>): boolean {
    // Sandbox MCP tools (SandboxBash, SetTitle) — always approve.
    // SandboxBash enforces restrictions at kernel level (sandbox-exec / bwrap),
    // so no additional permission gate is needed.
    if (toolName.startsWith(SANDBOX_MCP_PREFIX)) {
      // Intercept SetTitle: extract title from input and update session
      if (toolName === SET_TITLE_TOOL && input.title) {
        this.updateSessionTitle(sessionId, input.title as string);
      }
      return true;
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

  private sendControlResponse(
    proc: ChildProcess,
    controlRequestId: string,
    result: { behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string },
  ): void {
    // CLI's nu6() does Object.keys(result.updatedInput) without null check,
    // so always include updatedInput when allowing.
    const safeResult = result.behavior === 'allow'
      ? { ...result, updatedInput: result.updatedInput ?? {} }
      : result;
    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: controlRequestId,
        response: safeResult,
      },
    };
    try {
      proc.stdin!.write(JSON.stringify(response) + '\n');
    } catch (err) {
      console.error(`[cli] failed to send control_response:`, err);
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

  // ── Private: Helpers ──

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
}
