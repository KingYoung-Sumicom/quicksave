import { spawn, execSync, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import type { CardEvent, CardStreamEnd, ContextUsageBreakdown } from '@sumicom/quicksave-shared';
import { StreamCardBuilder } from './cardBuilder.js';
import { SANDBOX_MCP_NAME, SANDBOX_BASH_TOOL, buildSandboxMcpServerConfig } from './sandboxMcp.js';
import { DebugLogger } from './debugLogger.js';
import type {
  CodingAgentProvider,
  ProviderSession,
  ProviderCallbacks,
  StartSessionOpts,
  ResumeSessionOpts,
  PermissionLevel,
} from './provider.js';

const __ownDir = dirname(fileURLToPath(import.meta.url));

/**
 * Models that don't support the `context-1m-2025-08-07` beta. Today only
 * Haiku is locked to 200k; Sonnet and Opus all opt into 1M when asked.
 * Mirrors `modelSupports1m` in apps/pwa — kept as a separate copy so the
 * agent doesn't have to import from the PWA workspace.
 */
function modelSupports1m(model: string | undefined): boolean {
  return !!model && !/^claude-haiku/i.test(model);
}

/**
 * Append `[1m]` to the model so the Claude CLI enables the 1M context beta on
 * its API calls. We only do this for models that support it; for Haiku (or an
 * undefined model where we can't decide) we return the input unchanged. The
 * CLI strips the suffix before sending the actual model id to the API.
 */
export function decorateModelWithContextWindow(
  model: string | undefined,
  contextWindow: number | undefined,
): string | undefined {
  if (!model) return model;
  if (/\[1m\]$/i.test(model)) return model; // caller already opted in
  if (!contextWindow || contextWindow <= 200_000) return model;
  if (!modelSupports1m(model)) return model;
  return `${model}[1m]`;
}

/**
 * Build the argv passed to `claude` when spawning a new or resumed session.
 *
 * Exported for unit testing; production callers go through `ClaudeCliProvider`.
 *
 * Permission mode handling: `bypassPermissions` is translated to `default` on
 * the wire. Auto-approval is driven by a PermissionRequest hook whose command
 * consults a daemon-owned sentinel file (`opts.bypassFlagPath`). The daemon
 * creates/removes that file in `setPermissionLevel`, so the user can toggle
 * bypass mode at any time without re-spawning the CLI. Running the CLI in its
 * own `bypassPermissions` mode would suppress permission-prompt-tool calls and
 * freeze the decision at spawn time; the hook indirection keeps both tool-call
 * visibility and dynamic toggling.
 */
export function buildClaudeCliArgs(opts: {
  cwd: string;
  ownDir: string;
  model?: string;
  permissionMode?: PermissionLevel;
  systemPrompt?: string;
  resumeSessionId?: string;
  sandboxed?: boolean;
  bypassFlagPath?: string;
  /** Auto-compact ceiling. >200k triggers the `[1m]` model suffix so the API
   *  accepts the larger window; `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set on
   *  the spawn env (see `spawnAndConsume`) so the CLI compacts at this value. */
  contextWindow?: number;
}): string[] {
  const args: string[] = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--permission-prompt-tool', 'stdio',
    '--verbose',
    '-p', '',  // empty print flag — prompt sent via stdin
    '--replay-user-messages',  // keep CLI alive across stdin user messages (enables hot resume)
  ];

  if (opts.systemPrompt) {
    args.push('--append-system-prompt', opts.systemPrompt);
  }

  if (opts.model) {
    args.push('--model', decorateModelWithContextWindow(opts.model, opts.contextWindow) ?? opts.model);
  }

  if (opts.permissionMode) {
    const cliMode = opts.permissionMode === 'bypassPermissions' ? 'default'
      : opts.permissionMode === 'acceptEdits' ? 'acceptEdits'
      : opts.permissionMode === 'plan' ? 'plan'
      : opts.permissionMode === 'auto' ? 'auto'
      : 'default';
    args.push('--permission-mode', cliMode);
  }

  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }

  const permissionRequestHooks: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> = [];
  const sandboxAllowHook = {
    type: 'command',
    command: `printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'`,
  };
  if (opts.sandboxed) {
    permissionRequestHooks.push({ matcher: SANDBOX_BASH_TOOL, hooks: [sandboxAllowHook] });
  }
  if (opts.bypassFlagPath) {
    // Universal hook: if the sentinel file exists, approve the tool; otherwise
    // emit nothing so the CLI continues to the permission-prompt-tool (which
    // the daemon serves from AUTO_APPROVE + user interaction).
    const escapedPath = opts.bypassFlagPath.replace(/"/g, '\\"');
    const conditionalCommand = `[ -f "${escapedPath}" ] && printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' || true`;
    permissionRequestHooks.push({
      matcher: '*',
      hooks: [{ type: 'command', command: conditionalCommand }],
    });
  }
  if (permissionRequestHooks.length > 0) {
    args.push('--settings', JSON.stringify({ hooks: { PermissionRequest: permissionRequestHooks } }));
  }

  const mcpConfig = {
    mcpServers: {
      [SANDBOX_MCP_NAME]: buildSandboxMcpServerConfig({
        ownDir: opts.ownDir,
        cwd: opts.cwd,
        sessionId: opts.resumeSessionId,
      }),
    },
  };
  args.push('--mcp-config', JSON.stringify(mcpConfig));

  return args;
}

/**
 * Resolve the absolute path to the `claude` CLI binary.
 * When the daemon runs as a background service, PATH may not include the
 * directory where `claude` is installed, causing spawn ENOENT errors.
 * We resolve once and cache the result.
 */
let _claudeBin: string | undefined;
export function getClaudeBin(): string {
  if (_claudeBin) return _claudeBin;

  // 1. Try `which` — works when PATH is correct
  try {
    const resolved = execSync('which claude', { encoding: 'utf-8', timeout: 5_000 }).trim();
    if (resolved && existsSync(resolved)) {
      _claudeBin = resolved;
      return _claudeBin;
    }
  } catch { /* not in PATH */ }

  // 2. Check common install locations
  const home = process.env.HOME ?? '';
  const candidates = [
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
  ];
  // Also check nvm versions if present
  try {
    const nvmDir = join(home, '.nvm', 'versions', 'node');
    if (existsSync(nvmDir)) {
      for (const ver of readdirSync(nvmDir)) {
        candidates.push(join(nvmDir, ver, 'bin', 'claude'));
      }
    }
  } catch { /* ignore */ }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      _claudeBin = candidate;
      return _claudeBin;
    }
  }

  // 3. Fallback to bare name — will ENOENT if still not in PATH,
  //    but at least the error message is clear
  _claudeBin = 'claude';
  return _claudeBin;
}

/** Extract readable text from tool_result content (string or array of blocks). */
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

// ============================================================================
// CliProviderSession — wraps a ChildProcess for ProviderSession interface
// ============================================================================

export class CliProviderSession implements ProviderSession {
  public process: ChildProcess | null;
  /** Debug logger — attached after spawn so stdin writes are captured too. */
  public debugLog?: DebugLogger;
  /** Pending control_requests awaiting a control_response from the CLI. */
  public pendingControlResponses: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  /** True while a turn (prompt/compaction/tool loop) is in flight — control_requests may be queued by CLI. */
  public activeTurn: boolean = false;
  /** True once a `result` event has been processed for the current turn.
   * Consumed by consumeStream's finally block to decide whether the
   * process death counts as an unexpected exit. Reset externally on idle hot
   * resume (the new turn hasn't seen its result yet). */
  public resultEmitted: boolean = false;
  /** Card builder for this session — used by sendUserMessage to record the
   * follow-up prompt in streamingCards so getCards on refresh returns it
   * before the CLI has flushed it to the session JSONL. */
  public cardBuilder: StreamCardBuilder | null = null;

  constructor(proc: ChildProcess) {
    this.process = proc;
  }

  /**
   * Send a generic control_request and await the response from the CLI.
   * Timeout counts only idle time: while `activeTurn` is true the clock is
   * paused, so a compaction or long tool loop will not expire the request.
   */
  sendControlRequest(subtype: string, params?: Record<string, unknown>, idleTimeoutMs = 15_000): Promise<unknown> {
    if (!this.process || this.process.killed) {
      return Promise.reject(new Error('CLI process is not alive'));
    }
    const requestId = crypto.randomUUID();
    const request = { subtype, ...(params ?? {}) };
    const msg = { type: 'control_request', request_id: requestId, request };

    return new Promise((resolve, reject) => {
      const tickMs = 500;
      let idleAccumulated = 0;
      const timer = setInterval(() => {
        if (!this.activeTurn) idleAccumulated += tickMs;
        if (idleAccumulated >= idleTimeoutMs) {
          clearInterval(timer);
          this.pendingControlResponses.delete(requestId);
          reject(new Error(`Control request ${subtype} timed out after ${idleTimeoutMs}ms idle`));
        }
      }, tickMs);

      this.pendingControlResponses.set(requestId, {
        resolve: (v) => { clearInterval(timer); resolve(v); },
        reject: (e) => { clearInterval(timer); reject(e); },
      });

      try {
        this.debugLog?.logRawEvent({ ...msg, _direction: 'stdin' });
        this.process!.stdin!.write(JSON.stringify(msg) + '\n');
      } catch (err) {
        this.pendingControlResponses.delete(requestId);
        clearInterval(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  sendUserMessage(prompt: string): void {
    if (!this.process || this.process.killed) return;
    // Record the prompt in the cardBuilder so getCards on reconnect/refresh
    // returns it before the CLI has flushed it to the session JSONL. The PWA
    // already shows an optimistic user card, so we don't emit a card-event.
    // (--replay-user-messages will echo this prompt back to us; the
    // `isReplay` filter in routeMessage relies on this entry already
    // existing to dedupe.)
    this.cardBuilder?.userMessage(prompt);
    // Pause the idle clock immediately — CLI will start a new turn once it
    // reads this stdin, even before it emits the first stream event.
    this.activeTurn = true;
    const userMsg = {
      type: 'user',
      message: { role: 'user', content: prompt },
    };
    this.debugLog?.logRawEvent({ ...userMsg, _direction: 'stdin' });
    this.process.stdin!.write(JSON.stringify(userMsg) + '\n');
  }

  interrupt(): void {
    if (!this.process || this.process.killed) return;
    try {
      const interruptReq = {
        type: 'control_request',
        request_id: crypto.randomUUID(),
        request: { subtype: 'interrupt' },
      };
      this.debugLog?.logRawEvent({ ...interruptReq, _direction: 'stdin' });
      this.process.stdin!.write(JSON.stringify(interruptReq) + '\n');
    } catch {
      // If stdin write fails, kill the process
      this.process?.kill('SIGTERM');
    }
  }

  async getContextUsage(): Promise<ContextUsageBreakdown | null> {
    if (!this.process || this.process.killed) return null;
    // Wall-clock cap: sendControlRequest's idle clock pauses while another
    // turn is in flight, so without a hard ceiling this could hang across
    // back-to-back turns. 10s is plenty — the CLI normally answers in <100ms.
    const wallTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000));
    try {
      const response = await Promise.race([
        this.sendControlRequest('get_context_usage', undefined, 10_000),
        wallTimeout,
      ]);
      return (response as ContextUsageBreakdown | null) ?? null;
    } catch {
      return null;
    }
  }

  kill(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  get alive(): boolean {
    return !!this.process && !this.process.killed;
  }
}

// ============================================================================
// ClaudeCliProvider — implements CodingAgentProvider
// ============================================================================

export class ClaudeCliProvider implements CodingAgentProvider {
  readonly id = 'claude-code' as const;
  readonly historyMode = 'claude-jsonl' as const;

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
      systemPrompt: opts.systemPrompt,
      sandboxed: opts.sandboxed,
      bypassFlagPath: opts.bypassFlagPath,
      contextWindow: opts.contextWindow,
    });

    return this.spawnAndConsume(args, opts.cwd, opts.permissionLevel, opts.sandboxed, opts.prompt, cardBuilder, callbacks, opts.model, opts.contextWindow);
  }

  async resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const args = this.buildCliArgs({
      prompt: opts.prompt,
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionLevel,
      systemPrompt: opts.systemPrompt,
      resumeSessionId: opts.sessionId,
      sandboxed: opts.sandboxed,
      bypassFlagPath: opts.bypassFlagPath,
      contextWindow: opts.contextWindow,
    });

    return this.spawnAndConsume(args, opts.cwd, opts.permissionLevel, opts.sandboxed, opts.prompt, cardBuilder, callbacks, opts.model, opts.contextWindow);
  }

  // ── Private: CLI Args ──

  private buildCliArgs(opts: {
    prompt: string;
    cwd: string;
    model?: string;
    permissionMode?: PermissionLevel;
    systemPrompt?: string;
    resumeSessionId?: string;
    sandboxed?: boolean;
    bypassFlagPath?: string;
    contextWindow?: number;
  }): string[] {
    return buildClaudeCliArgs({ ...opts, ownDir: __ownDir });
  }

  // ── Private: Spawn & Consume ──

  private async spawnAndConsume(
    args: string[],
    cwd: string,
    _level: PermissionLevel,
    _sandboxed: boolean,
    prompt: string,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    _model?: string,
    contextWindow?: number,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const claudeBin = getClaudeBin();
    // The CLI auto-promotes Sonnet/Opus to 1M context unless told otherwise.
    // Pin the auto-compact window to the user's chosen tier so usage stays
    // predictable across model switches and 200k/500k/1M presets all behave
    // the way the picker says they will.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (contextWindow && contextWindow > 0) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextWindow);
    }
    const proc = spawn(claudeBin, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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
              callbacks.onModelDetected(msg.model);
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

    const cliSession = new CliProviderSession(proc);
    cliSession.cardBuilder = cardBuilder;
    const debugLog = new DebugLogger(sessionId);
    cliSession.debugLog = debugLog;

    // Log the initial stdin prompt that was sent before init
    debugLog.logRawEvent({ ...userMsg, _direction: 'stdin' });

    // Update the cardBuilder sessionId (it may have been created with a placeholder)
    cardBuilder.updateSessionId(sessionId);

    // Fire and forget the stream consumer — pass the same readline interface
    this.consumeStream(sessionId, rl, bufferedLines, cliSession, cardBuilder, callbacks, prompt, debugLog);

    return { sessionId, session: cliSession };
  }

  // ── Private: Stream Consumer ──

  private async consumeStream(
    sessionId: string,
    rl: ReturnType<typeof createInterface>,
    bufferedLines: string[],
    cliSession: CliProviderSession,
    cb: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    prompt?: string,
    debugLog?: DebugLogger,
  ): Promise<void> {
    cliSession.resultEmitted = false;
    let textBuffer = '';
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;

    const emitCard = (event: CardEvent) => {
      debugLog?.logCardEvent(event);
      callbacks.emitCardEvent(event);
    };

    cb.startNewTurn();
    cliSession.activeTurn = true;

    // Add user prompt to cardBuilder (for getCards on reconnect) but don't emit
    // as a card-event — the PWA already shows an optimistic user card.
    if (prompt) {
      const userCardEvent = cb.userMessage(prompt);
      debugLog?.logCardEvent(userCardEvent); // log to debug cards JSONL even though not emitted to PWA
    }

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

      debugLog?.logRawEvent(msg);

      const emittedResult = await this.routeMessage(sessionId, msg, cliSession, cb, callbacks, emitCard, flushText, bufferText, debugLog);
      if (emittedResult) {
        cliSession.resultEmitted = true;
        cb.startNewTurn();
        cliSession.activeTurn = false;
      }
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
      callbacks.emitStreamEnd({ sessionId, success: false, error: msg });
      cliSession.resultEmitted = true;
    } finally {
      if (bufferTimer) clearTimeout(bufferTimer);
      // Process exited — clean up
      cliSession.process = null;
      cliSession.activeTurn = false;

      // Fail any still-pending control_requests — no response will ever arrive.
      for (const [reqId, pending] of cliSession.pendingControlResponses) {
        cliSession.pendingControlResponses.delete(reqId);
        pending.reject(new Error('CLI process exited before control_response'));
      }

      if (!cliSession.resultEmitted) {
        callbacks.emitStreamEnd({ sessionId, success: false, error: 'Process exited unexpectedly' });
      }

      // Notify SessionManager so it can remove the entry and emit
      // `session-updated { isActive: false }`. Without this the badge stays
      // on "Standby" forever when the CLI dies between turns.
      callbacks.onSessionExited?.(sessionId, cliSession);
    }
  }

  // ── Private: Route a single stream-json message ──
  // Returns true if a result/stream-end was emitted.

  private async routeMessage(
    sessionId: string,
    msg: any,
    cliSession: CliProviderSession,
    cb: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    emitCard: (event: CardEvent) => void,
    flushText: () => void,
    bufferText: (text: string) => void,
    debugLog?: DebugLogger,
  ): Promise<boolean> {
    // ── Control requests (permissions) ──
    if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
      await this.handleControlRequest(sessionId, msg, cliSession, callbacks);
      return false;
    }

    // Route control_response to a pending request if we have one
    if (msg.type === 'control_response') {
      const responseBody = msg.response;
      const reqId: string | undefined = responseBody?.request_id;
      if (reqId) {
        const pending = cliSession.pendingControlResponses.get(reqId);
        if (pending) {
          cliSession.pendingControlResponses.delete(reqId);
          if (responseBody.subtype === 'success') {
            pending.resolve(responseBody.response);
          } else {
            pending.reject(new Error(responseBody.error ?? 'control_request failed'));
          }
        } else {
          // Unmatched response: almost always an echo from --replay-user-messages of a
          // control_response WE sent (e.g. permission decision). Leave a debug line rather
          // than a warning since this is expected in replay mode.
          console.debug(`[cli] control_response with no matching pending request (likely replay echo): request_id=${reqId} subtype=${responseBody?.subtype} session=${sessionId.slice(0, 8)}`);
        }
      }
      return false;
    }
    if (msg.type === 'control_cancel_request') return false;

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
      } else if (msg.subtype === 'compact_boundary') {
        // Compaction happened mid-turn: emit a visible "Context compacted" card
        // and refresh the cache anchor — the summarization API call wrote a new
        // cache entry, so the 5-min TTL restarts now.
        flushText();
        const meta = msg.compact_metadata;
        const trigger = meta?.trigger as 'manual' | 'auto' | undefined;
        const preTokens = typeof meta?.pre_tokens === 'number' ? meta.pre_tokens : undefined;
        const text = preTokens !== undefined
          ? `Context compacted (${trigger ?? 'manual'}, was ${preTokens.toLocaleString()} tokens)`
          : 'Context compacted';
        emitCard(cb.systemMessage(text, 'compacted'));
        callbacks.onCacheTouch?.(sessionId);
      }
      return false;
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
      return false;
    }

    // ── Rate limit events ──
    if (msg.type === 'rate_limit_event') return false;

    // ── Complete assistant messages ──
    if (msg.type === 'assistant') {
      if (msg.agentId) return false;  // sidechain
      // Per Anthropic docs, the prompt cache TTL refreshes on every cache hit
      // (read) or write, so each inner API call inside an autonomous turn
      // resets the countdown. Notify the manager so the PWA's SessionStatsBar
      // countdown stays accurate mid-turn.
      const usage = msg.message?.usage;
      if (usage && ((usage.cache_creation_input_tokens ?? 0) > 0 || (usage.cache_read_input_tokens ?? 0) > 0)) {
        callbacks.onCacheTouch?.(sessionId);
      }
      flushText();
      const blocks = msg.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'thinking') {
          // Skip empty thinking blocks so they don't fall through to the
          // unknown-block catch-all below and render as "[thinking] …".
          if (block.thinking) emitCard(cb.thinkingBlock(block.thinking));
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
          callbacks.onToolUse?.(sessionId, block.name, block.input ?? {});
          if (block.name !== 'Agent') {
            emitCard(cb.toolUse(block.name, block.input ?? {}, block.id));
          }
        } else if (block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
          console.log(`[cli:debug] mcp_tool_use name=${block.name} id=${block.id}`);
          callbacks.onToolUse?.(sessionId, block.name ?? block.type, block.input ?? {});
          emitCard(cb.toolUse(block.name ?? block.type, block.input ?? {}, block.id ?? ''));
        } else if (block.type && block.type !== 'tool_use') {
          // Unknown block type — surface as info card so it's visible
          const preview = block.text ?? block.content ?? '';
          const previewStr = typeof preview === 'string' ? preview.slice(0, 200) : JSON.stringify(preview).slice(0, 200);
          emitCard(cb.systemMessage(`[${block.type}] ${previewStr}`, 'info'));
        }
      }
      return false;
    }

    // ── User messages (prompts + tool results) ──
    if (msg.type === 'user') {
      if (msg.agentId) return false;  // sidechain
      if (msg.isReplay) return false;  // echoed back by --replay-user-messages; we already added it to cardBuilder history
      const content = msg.message?.content;
      if (typeof content === 'string' && content) {
        flushText();
        emitCard(cb.userMessage(content));
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            flushText();
            emitCard(cb.userMessage(block.text));
          }
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
            console.log(`[cli:debug] ${block.type} tool_use_id=${parentId} content=${resultContent.slice(0, 80)}`);
            if (parentId) {
              const cardEvt = cb.toolResult(parentId, resultContent, !!block.is_error);
              console.log(`[cli:debug] toolResult cardEvt=${cardEvt ? 'emitted' : 'NULL (no matching tool_use)'}`);
              if (cardEvt) emitCard(cardEvt);
            }
          } else if (block.type !== 'text' && block.type !== 'tool_result') {
            // Unknown user block type — surface as info card
            const preview = block.text ?? block.content ?? '';
            const previewStr = typeof preview === 'string' ? preview.slice(0, 200) : JSON.stringify(preview).slice(0, 200);
            emitCard(cb.systemMessage(`[${block.type}] ${previewStr}`, 'info'));
          }
        }
      }
      return false;
    }

    // ── Result ──
    if (msg.type === 'result') {
      if (msg.session_id !== sessionId) return false;  // subagent result
      flushText();
      const terminalReason: string | undefined = msg.terminal_reason;
      const interrupted = terminalReason === 'aborted_tools' || terminalReason === 'aborted_streaming';
      const modelUsage = (msg as any).modelUsage as Record<string, { contextWindow?: number; costUSD?: number }> | undefined;
      const modelSummary = modelUsage
        ? Object.entries(modelUsage).map(([m, u]) => `${m}(ctx=${u.contextWindow ?? '?'})`).join(', ')
        : '?';
      console.log(`[cli] result session=${sessionId.slice(0, 8)} subtype=${msg.subtype} cost=$${msg.total_cost_usd?.toFixed(4) ?? '?'} models=[${modelSummary}]`);

      if (interrupted) {
        emitCard(cb.systemMessage('User interrupted'));
      }

      const finalizeEvent = cb.finalizeAssistantText();
      if (finalizeEvent) emitCard(finalizeEvent);

      const usage = msg.usage as
        | { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
        | undefined;
      if (usage && ((usage.cache_creation_input_tokens ?? 0) > 0 || (usage.cache_read_input_tokens ?? 0) > 0)) {
        callbacks.onCacheTouch?.(sessionId);
      }
      const streamEnd: CardStreamEnd = {
        sessionId,
        success: msg.subtype === 'success' && !interrupted,
        error: (msg.subtype !== 'success' && !interrupted)
          ? (msg.errors?.join('; ') || `Session ended: ${msg.subtype}`)
          : undefined,
        interrupted,
        totalCostUsd: msg.total_cost_usd,
        tokenUsage: usage
          ? {
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
              cacheCreation: usage.cache_creation_input_tokens,
              cacheRead: usage.cache_read_input_tokens,
            }
          : undefined,
      };
      callbacks.emitStreamEnd(streamEnd);

      // Defer clearing in-memory cards until JSONL has stabilized: the CLI may
      // not have flushed all messages to JSONL by the time `result` arrives on
      // stdout. Clearing synchronously creates a window where getCards() sees
      // neither the streamingCards (cleared) nor the final turn (not flushed).
      debugLog?.logCardBuilderSnapshot(cb.getCards());
      void cb.scheduleDeferredClear();

      return true;
    }

    return false;
  }

  // ── Private: Permission Handling via control_request ──

  private async handleControlRequest(
    sessionId: string,
    msg: any,
    cliSession: CliProviderSession,
    callbacks: ProviderCallbacks,
  ): Promise<void> {
    if (!cliSession.process) return;

    const req = msg.request;
    const controlRequestId = msg.request_id;
    const toolName = req.tool_name ?? 'Unknown';
    const toolInput = req.input ?? {};
    const toolUseId = req.tool_use_id ?? '';

    // Delegate permission decision to SessionManager via callbacks
    const decision = await callbacks.handlePermissionRequest(sessionId, { toolName, toolInput, toolUseId });

    if (decision.action === 'deny') {
      this.sendControlResponse(cliSession.process, controlRequestId, {
        behavior: 'deny',
        message: decision.response || 'Denied',
      }, cliSession.debugLog);
    } else {
      this.sendControlResponse(cliSession.process, controlRequestId, {
        behavior: 'allow',
        updatedInput: decision.updatedInput,
      }, cliSession.debugLog);
    }
  }

  private sendControlResponse(
    proc: ChildProcess,
    controlRequestId: string,
    result: { behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string },
    debugLog?: DebugLogger,
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
    debugLog?.logRawEvent({ ...response, _direction: 'stdin' });
    try {
      proc.stdin!.write(JSON.stringify(response) + '\n');
    } catch (err) {
      console.error(`[cli] failed to send control_response:`, err);
    }
  }
}
