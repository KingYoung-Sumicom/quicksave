import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  Options,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  PermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import type { CardEvent, CardStreamEnd } from '@sumicom/quicksave-shared';
import { StreamCardBuilder } from './cardBuilder.js';
import { SANDBOX_MCP_NAME, SANDBOX_BASH_TOOL, buildSandboxMcpServerConfig } from './sandboxMcp.js';
import { AsyncQueue } from './asyncQueue.js';
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
// SdkProviderSession — wraps SDK Query for ProviderSession interface
// ============================================================================

class SdkProviderSession implements ProviderSession {
  private queryHandle: Query | null;
  private inputQueue: AsyncQueue<SDKUserMessage>;
  /** StreamIds queued by hot resume — consumeStream pops after each result. */
  public pendingStreamIds: string[] = [];

  constructor(queryHandle: Query, inputQueue: AsyncQueue<SDKUserMessage>) {
    this.queryHandle = queryHandle;
    this.inputQueue = inputQueue;
  }

  sendUserMessage(prompt: string): void {
    if (!this.queryHandle) return;
    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    };
    this.inputQueue.push(userMsg);
  }

  interrupt(): void {
    if (!this.queryHandle) return;
    this.queryHandle.interrupt().catch((err) => {
      console.error('[sdk] interrupt failed:', err);
    });
  }

  kill(): void {
    if (this.queryHandle) {
      this.queryHandle.close();
      this.queryHandle = null;
    }
    this.inputQueue.end();
  }

  get alive(): boolean {
    return this.queryHandle !== null;
  }

  /** Called when the stream ends naturally (query generator completes). */
  markClosed(): void {
    this.queryHandle = null;
  }
}

// ============================================================================
// ClaudeSdkProvider — implements CodingAgentProvider via SDK query() API
// ============================================================================

export class ClaudeSdkProvider implements CodingAgentProvider {
  readonly id = 'claude-code' as const;
  readonly historyMode = 'claude-jsonl' as const;

  async startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const inputQueue = new AsyncQueue<SDKUserMessage>();

    // Push first user message
    const firstMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: opts.prompt },
      parent_tool_use_id: null,
    };
    inputQueue.push(firstMsg);

    const sessionIdRef = { current: '' };
    const options = this.buildOptions(opts, callbacks, sessionIdRef);

    const queryHandle = sdkQuery({ prompt: inputQueue, options });

    // Wait for init message to get sessionId
    const sessionId = await this.waitForInit(queryHandle, callbacks);
    sessionIdRef.current = sessionId;

    const sdkSession = new SdkProviderSession(queryHandle, inputQueue);

    // Update cardBuilder with real sessionId
    cardBuilder.updateSessionId(sessionId);

    // Fire and forget the stream consumer
    this.consumeStream(sessionId, opts.streamId, queryHandle, sdkSession, cardBuilder, callbacks, opts.prompt);

    return { sessionId, session: sdkSession };
  }

  async resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const inputQueue = new AsyncQueue<SDKUserMessage>();

    // Push resume prompt
    const resumeMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: opts.prompt },
      parent_tool_use_id: null,
    };
    inputQueue.push(resumeMsg);

    const sessionIdRef = { current: opts.sessionId };
    const options = this.buildOptions(opts, callbacks, sessionIdRef, opts.sessionId);

    const queryHandle = sdkQuery({ prompt: inputQueue, options });

    // Wait for init message
    const sessionId = await this.waitForInit(queryHandle, callbacks);
    sessionIdRef.current = sessionId;

    const sdkSession = new SdkProviderSession(queryHandle, inputQueue);

    // Update cardBuilder with confirmed sessionId
    cardBuilder.updateSessionId(sessionId);

    // Fire and forget
    this.consumeStream(sessionId, opts.streamId, queryHandle, sdkSession, cardBuilder, callbacks, opts.prompt);

    return { sessionId, session: sdkSession };
  }

  // ── Private: Build SDK Options ──

  private buildOptions(
    opts: StartSessionOpts | ResumeSessionOpts,
    callbacks: ProviderCallbacks,
    sessionIdRef: { current: string },
    resumeSessionId?: string,
  ): Options {
    const permissionMode = this.mapPermissionMode(opts.permissionLevel);

    const { sandboxed } = opts;

    const canUseTool = async (
      toolName: string,
      toolInput: Record<string, unknown>,
      permOpts: { signal: AbortSignal; toolUseID: string; agentID?: string; title?: string; [key: string]: any },
    ): Promise<PermissionResult> => {
      // SandboxBash runs inside a kernel sandbox — auto-approve when session is sandboxed.
      // Check here (not only in sessionManager) because the SDK may call canUseTool
      // before the session is registered (e.g. during MCP tool discovery).
      if (sandboxed && toolName === SANDBOX_BASH_TOOL) {
        return { behavior: 'allow' };
      }

      const decision = await callbacks.handlePermissionRequest(sessionIdRef.current, {
        toolName,
        toolInput,
        toolUseId: permOpts.toolUseID,
      });

      if (decision.action === 'deny') {
        return { behavior: 'deny', message: decision.response || 'User denied permission' };
      }

      return {
        behavior: 'allow',
        updatedInput: decision.updatedInput,
      };
    };

    const options: Options = {
      cwd: opts.cwd,
      permissionMode,
      canUseTool,
      includePartialMessages: true,
      settingSources: ['project'],
      mcpServers: {
        [SANDBOX_MCP_NAME]: buildSandboxMcpServerConfig({
          ownDir: __ownDir,
          cwd: opts.cwd,
          sessionId: resumeSessionId,
        }),
      },
      systemPrompt: opts.systemPrompt
        ? { type: 'preset', preset: 'claude_code', append: opts.systemPrompt }
        : { type: 'preset', preset: 'claude_code' },
    };

    if ('model' in opts && opts.model) {
      options.model = opts.model;
    }

    if (permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    }

    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

    return options;
  }

  private mapPermissionMode(level: PermissionLevel): PermissionMode {
    switch (level) {
      case 'bypassPermissions': return 'bypassPermissions';
      case 'acceptEdits': return 'acceptEdits';
      case 'plan': return 'plan';
      default: return 'default';
    }
  }

  // ── Private: Wait for Init ──

  private async waitForInit(queryHandle: Query, callbacks: ProviderCallbacks): Promise<string> {
    const timeout = setTimeout(() => {
      throw new Error('Timeout waiting for SDK init');
    }, 30_000);

    try {
      for await (const msg of queryHandle) {
        if (msg.type === 'system' && (msg as any).subtype === 'init' && (msg as any).session_id) {
          const initMsg = msg as any;
          if (initMsg.model) {
            callbacks.onModelDetected(initMsg.model);
          }
          clearTimeout(timeout);
          return initMsg.session_id;
        }
        // Buffer non-init messages — they will be consumed in consumeStream
        // Since we can't "unread" from the async generator, we break after init
        // and let consumeStream handle remaining messages.
        // Actually, for a generator we can't push back. We need to handle
        // the first non-init messages here. But the SDK should emit init first.
        // If we get a non-init message, skip it (unlikely before init).
      }
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }

    clearTimeout(timeout);
    throw new Error('SDK query ended without init message');
  }

  // ── Private: Stream Consumer ──

  private async consumeStream(
    sessionId: string,
    initialStreamId: string,
    queryHandle: Query,
    sdkSession: SdkProviderSession,
    cb: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    prompt?: string,
  ): Promise<void> {
    let streamId = initialStreamId;
    let textBuffer = '';
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;
    let resultEmitted = false;

    const emitCard = (event: CardEvent) => { callbacks.emitCardEvent(event); };

    cb.startNewTurn(streamId);

    // Add user prompt to cardBuilder (for getCards on reconnect) but don't emit
    if (prompt) {
      cb.userMessage(prompt);
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

    try {
      for await (const msg of queryHandle) {
        const emittedResult = await this.routeMessage(
          sessionId, streamId, msg, sdkSession, cb, callbacks, emitCard, flushText, bufferText,
        );
        if (emittedResult) {
          resultEmitted = true;

          // Check for hot resume — start new turn with next pending streamId
          const nextStreamId = sdkSession.pendingStreamIds.shift();
          if (nextStreamId) {
            streamId = nextStreamId;
            cb.startNewTurn(streamId);
            resultEmitted = false; // Reset for next turn
          }
        }
      }
    } catch (error) {
      flushText();
      console.error(`[sdk] stream error session=${sessionId.slice(0, 8)}:`, error);
      const msg = error instanceof Error ? error.message : 'Unknown error';
      callbacks.emitStreamEnd({ streamId, sessionId, success: false, error: msg });
      resultEmitted = true;
    } finally {
      if (bufferTimer) clearTimeout(bufferTimer);
      sdkSession.markClosed();

      if (!resultEmitted) {
        callbacks.emitStreamEnd({ streamId, sessionId, success: false, error: 'SDK query ended unexpectedly' });
      }
    }
  }

  // ── Private: Route a single SDK message ──
  // Returns true if a result/stream-end was emitted.

  private async routeMessage(
    sessionId: string,
    streamId: string,
    msg: SDKMessage,
    _sdkSession: SdkProviderSession,
    cb: StreamCardBuilder,
    callbacks: ProviderCallbacks,
    emitCard: (event: CardEvent) => void,
    flushText: () => void,
    bufferText: (text: string) => void,
  ): Promise<boolean> {

    // ── System events ──
    if (msg.type === 'system') {
      const subtype = (msg as any).subtype;

      if (subtype === 'init') {
        // Already handled in waitForInit — skip
        return false;
      }

      if (subtype === 'task_started') {
        flushText();
        const m = msg as any;
        emitCard(cb.subagentStart(m.description ?? '', m.task_id, m.tool_use_id));
        return false;
      }

      if (subtype === 'task_progress') {
        const m = msg as any;
        const cardEvt = cb.subagentProgress(m.task_id, m.tool_use_id, m.usage?.tool_uses, m.last_tool_name);
        if (cardEvt) emitCard(cardEvt);
        return false;
      }

      if (subtype === 'task_notification') {
        const m = msg as any;
        const cardEvt = cb.subagentEnd(m.task_id, m.tool_use_id, m.status, m.summary);
        if (cardEvt) emitCard(cardEvt);
        return false;
      }

      // Other system subtypes (status, session_state_changed, compact_boundary, etc.) — skip
      return false;
    }

    // ── Streaming partial events ──
    if (msg.type === 'stream_event') {
      // Filter subagent stream events by parent_tool_use_id
      if (msg.parent_tool_use_id) return false;

      const event = (msg as any).event;
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
      // Filter subagent messages by parent_tool_use_id
      if (msg.parent_tool_use_id) return false;

      flushText();
      const blocks = (msg as any).message?.content ?? [];
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
          callbacks.onToolUse?.(sessionId, block.name, block.input ?? {});
          if (block.name !== 'Agent') {
            emitCard(cb.toolUse(block.name, block.input ?? {}, block.id));
          }
        } else if (block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
          callbacks.onToolUse?.(sessionId, block.name ?? block.type, block.input ?? {});
          emitCard(cb.toolUse(block.name ?? block.type, block.input ?? {}, block.id ?? ''));
        }
      }
      return false;
    }

    // ── User messages (tool results) ──
    if (msg.type === 'user') {
      // Filter subagent messages by parent_tool_use_id
      if (msg.parent_tool_use_id) return false;

      const content = (msg as any).message?.content;
      // Skip user text echoes — we already have them from the inputQueue
      if (typeof content === 'string') return false;

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
      return false;
    }

    // ── Result ──
    if (msg.type === 'result') {
      if ((msg as any).session_id !== sessionId) return false; // subagent result

      flushText();
      const terminalReason: string | undefined = (msg as any).terminal_reason;
      const interrupted = terminalReason === 'aborted_tools' || terminalReason === 'aborted_streaming';
      const totalCost = (msg as any).total_cost_usd;
      const modelUsage = (msg as any).modelUsage as Record<string, { contextWindow?: number; costUSD?: number }> | undefined;
      const modelSummary = modelUsage
        ? Object.entries(modelUsage).map(([m, u]) => `${m}(ctx=${u.contextWindow ?? '?'})`).join(', ')
        : '?';
      console.log(`[sdk] result session=${sessionId.slice(0, 8)} subtype=${msg.subtype} cost=$${totalCost?.toFixed(4) ?? '?'} models=[${modelSummary}]`);

      if (interrupted) {
        emitCard(cb.systemMessage('User interrupted'));
      }

      const finalizeEvent = cb.finalizeAssistantText();
      if (finalizeEvent) emitCard(finalizeEvent);

      const usage = (msg as any).usage;
      const errors = (msg as any).errors;
      const streamEnd: CardStreamEnd = {
        streamId,
        sessionId,
        success: msg.subtype === 'success' && !interrupted,
        error: (msg.subtype !== 'success' && !interrupted)
          ? (errors?.join('; ') || `Session ended: ${msg.subtype}`)
          : undefined,
        interrupted,
        totalCostUsd: totalCost,
        tokenUsage: usage
          ? {
              input: usage.input_tokens,
              output: usage.output_tokens,
              cacheCreation: usage.cache_creation_input_tokens,
              cacheRead: usage.cache_read_input_tokens,
            }
          : undefined,
      };
      callbacks.emitStreamEnd(streamEnd);

      // Defer clearing in-memory cards until JSONL has stabilized: the SDK may
      // not have flushed the turn's assistant messages to the session JSONL by
      // the time the result message lands. scheduleDeferredClear waits for the
      // file to stop growing, then atomically clears streamingCards and resets
      // cutoff to the final size.
      void cb.scheduleDeferredClear();

      return true;
    }

    return false;
  }
}
