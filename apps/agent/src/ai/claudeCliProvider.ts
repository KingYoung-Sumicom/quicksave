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

  constructor(proc: ChildProcess) {
    this.process = proc;
  }

  sendUserMessage(prompt: string): void {
    if (!this.process || this.process.killed) return;
    const userMsg = {
      type: 'user',
      message: { role: 'user', content: prompt },
    };
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
      this.process.stdin!.write(JSON.stringify(interruptReq) + '\n');
    } catch {
      // If stdin write fails, kill the process
      this.process?.kill('SIGTERM');
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

  async startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const sandboxNote = opts.sandboxed
      ? '[Sandbox mode: ON — use SandboxBash from quicksave-sandbox MCP for shell commands.]'
      : '[Sandbox mode: OFF — SandboxBash is available but disabled.]';
    const systemParts = [sandboxNote, opts.systemPrompt].filter(Boolean).join('\n');
    const prompt = `[System context: ${systemParts}]\n\n${opts.prompt}`;

    const args = this.buildCliArgs({
      prompt,
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionLevel,
      sandboxed: opts.sandboxed,
    });

    return this.spawnAndConsume(args, opts.cwd, opts.streamId, opts.permissionLevel, opts.sandboxed, prompt, cardBuilder, callbacks, opts.model);
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

    return this.spawnAndConsume(args, opts.cwd, opts.streamId, opts.permissionLevel, opts.sandboxed, opts.prompt, cardBuilder, callbacks);
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
    _level: PermissionLevel,
    _sandboxed: boolean,
    prompt: string,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    _model?: string,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
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

    // Update the cardBuilder sessionId (it may have been created with a placeholder)
    cardBuilder.updateSessionId(sessionId);

    // Fire and forget the stream consumer — pass the same readline interface
    this.consumeStream(sessionId, streamId, rl, bufferedLines, cliSession, cardBuilder, callbacks);

    return { sessionId, session: cliSession };
  }

  // ── Private: Stream Consumer ──

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
    let resultEmitted = false;

    const emitCard = (event: CardEvent) => { callbacks.emitCardEvent(event); };

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

      const emittedResult = await this.routeMessage(sessionId, streamId, msg, cliSession, cb, callbacks, emitCard, flushText, bufferText);
      if (emittedResult) resultEmitted = true;
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
  ): Promise<boolean> {
    // ── Control requests (permissions) ──
    if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
      await this.handleControlRequest(sessionId, msg, cliSession, callbacks);
      return false;
    }

    // Skip control echoes
    if (msg.type === 'control_response' || msg.type === 'control_cancel_request') return false;

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
          emitCard(cb.toolUse(block.name ?? block.type, block.input ?? {}, block.id ?? ''));
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
            if (parentId) {
              const cardEvt = cb.toolResult(parentId, resultContent, !!block.is_error);
              if (cardEvt) emitCard(cardEvt);
            }
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
      callbacks.emitStreamEnd(streamEnd);

      // Clear accumulated cards — the JSONL now has the full history for this turn.
      // cardBuilder should only hold cards for the next in-progress turn.
      cb.clearCards();
      // Update cutoff so the next turn's getCards() reads JSONL up to here.
      await cb.snapshotCutoff();

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
}
