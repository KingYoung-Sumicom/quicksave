import { spawn, execSync, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import type { CardEvent, CardStreamEnd, ContextUsageBreakdown } from '@sumicom/quicksave-shared';
import { StreamCardBuilder } from './cardBuilder.js';
import { SANDBOX_MCP_NAME, SANDBOX_BASH_TOOL } from './sandboxMcp.js';
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
 * Resolve the absolute path to the `claude` CLI binary.
 * When the daemon runs as a background service, PATH may not include the
 * directory where `claude` is installed, causing spawn ENOENT errors.
 * We resolve once and cache the result.
 */
let _claudeBin: string | undefined;
function getClaudeBin(): string {
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

class CliProviderSession implements ProviderSession {
  public process: ChildProcess | null;
  /** StreamIds queued by hot resume — consumeStream pops after each result. */
  public pendingStreamIds: string[] = [];
  /** Debug logger — attached after spawn so stdin writes are captured too. */
  public debugLog?: DebugLogger;
  /** Pending control_requests awaiting a control_response from the CLI. */
  public pendingControlResponses: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  /** True while a turn (prompt/compaction/tool loop) is in flight — control_requests may be queued by CLI. */
  public activeTurn: boolean = false;

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
    });

    return this.spawnAndConsume(args, opts.cwd, opts.streamId, opts.permissionLevel, opts.sandboxed, opts.prompt, cardBuilder, callbacks, opts.model);
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
    });

    return this.spawnAndConsume(args, opts.cwd, opts.streamId, opts.permissionLevel, opts.sandboxed, opts.prompt, cardBuilder, callbacks, opts.model);
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
  }): string[] {
    const args: string[] = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--verbose',
      '-p', '',  // empty print flag — prompt sent via stdin
    ];

    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }

    if (opts.model) {
      args.push('--model', opts.model);
    }

    if (opts.permissionMode) {
      const cliMode = opts.permissionMode === 'bypassPermissions' ? 'bypassPermissions'
        : opts.permissionMode === 'acceptEdits' ? 'acceptEdits'
        : opts.permissionMode === 'plan' ? 'plan'
        : opts.permissionMode === 'auto' ? 'auto'
        : 'default';
      args.push('--permission-mode', cliMode);
    }

    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }

    // When sandboxed, inject a PermissionRequest hook that auto-approves SandboxBash.
    // This works in any project directory — no project-level settings needed.
    if (opts.sandboxed) {
      const hookSettings = {
        hooks: {
          PermissionRequest: [{
            matcher: SANDBOX_BASH_TOOL,
            hooks: [{
              type: 'command',
              command: `printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'`,
            }],
          }],
        },
      };
      args.push('--settings', JSON.stringify(hookSettings));
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
    _level: PermissionLevel,
    _sandboxed: boolean,
    prompt: string,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    _model?: string,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const claudeBin = getClaudeBin();
    const proc = spawn(claudeBin, args, {
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
    const debugLog = new DebugLogger(sessionId);
    cliSession.debugLog = debugLog;

    // Log the initial stdin prompt that was sent before init
    debugLog.logRawEvent({ ...userMsg, _direction: 'stdin' });

    // Update the cardBuilder sessionId (it may have been created with a placeholder)
    cardBuilder.updateSessionId(sessionId);

    // Fire and forget the stream consumer — pass the same readline interface
    this.consumeStream(sessionId, streamId, rl, bufferedLines, cliSession, cardBuilder, callbacks, prompt, debugLog);

    return { sessionId, session: cliSession };
  }

  // ── Private: Stream Consumer ──

  private async consumeStream(
    sessionId: string,
    initialStreamId: string,
    rl: ReturnType<typeof createInterface>,
    bufferedLines: string[],
    cliSession: CliProviderSession,
    cb: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    prompt?: string,
    debugLog?: DebugLogger,
  ): Promise<void> {
    let streamId = initialStreamId;
    let textBuffer = '';
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;
    let resultEmitted = false;

    const emitCard = (event: CardEvent) => {
      debugLog?.logCardEvent(event);
      callbacks.emitCardEvent(event);
    };

    cb.startNewTurn(streamId);
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

      const emittedResult = await this.routeMessage(sessionId, streamId, msg, cliSession, cb, callbacks, emitCard, flushText, bufferText, debugLog);
      if (emittedResult) {
        resultEmitted = true;

        // Hot resume: if there's a pending streamId, start a new turn for it.
        // This must live here (not in routeMessage) so the outer `streamId`
        // variable is updated — routeMessage receives it by value.
        const nextStreamId = cliSession.pendingStreamIds.shift();
        if (nextStreamId) {
          // Hot resume: re-snapshot cutoff now that the turn is committed to JSONL,
          // so getCards() doesn't duplicate the new turn's messages.
          await cb.snapshotCutoff();
          streamId = nextStreamId;
          cb.startNewTurn(streamId);
          cliSession.activeTurn = true;
          resultEmitted = false; // Reset for next turn
        } else {
          cliSession.activeTurn = false;
        }
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
      callbacks.emitStreamEnd({ streamId, sessionId, success: false, error: msg });
      resultEmitted = true;
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

      if (!resultEmitted) {
        // Process died without result — emit error
        callbacks.emitStreamEnd({ streamId, sessionId, success: false, error: 'Process exited unexpectedly' });
      }
    }
  }

  // ── Private: Route a single stream-json message ──
  // Returns true if a result/stream-end was emitted.

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
          // Unmatched response — diagnostic for missed routing (e.g. wrong cliSession instance).
          console.warn(`[cli] control_response with no matching pending request: request_id=${reqId} subtype=${responseBody?.subtype} session=${sessionId.slice(0, 8)} pending_keys=[${Array.from(cliSession.pendingControlResponses.keys()).join(',')}]`);
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
          console.log(`[cli:debug] mcp_tool_use name=${block.name} id=${block.id}`);
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
          ? {
              input: msg.usage.input_tokens,
              output: msg.usage.output_tokens,
              cacheCreation: (msg.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
              cacheRead: (msg.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens,
            }
          : undefined,
      };
      callbacks.emitStreamEnd(streamEnd);

      // Snapshot and clear in-memory cards. After clearCards(), set cutoff to
      // null so getCards() reads the full JSONL — the active turn is now part
      // of the persisted history. snapshotCutoff() alone is unreliable here
      // because Claude Code may not have flushed all messages to the JSONL by
      // the time the result arrives on stdout (race condition).
      debugLog?.logCardBuilderSnapshot(cb.getCards());
      cb.clearCards();
      cb.jsonlCutoff = null;

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
