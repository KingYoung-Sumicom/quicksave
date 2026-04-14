import { Codex } from '@openai/codex-sdk';
import type {
  Thread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  ApprovalMode,
  SandboxMode,
} from '@openai/codex-sdk';
import type { CardEvent, CardStreamEnd } from '@sumicom/quicksave-shared';
import type { StreamCardBuilder } from './cardBuilder.js';
import type {
  CodingAgentProvider,
  ProviderCallbacks,
  ProviderSession,
  StartSessionOpts,
  ResumeSessionOpts,
  PermissionLevel,
} from './provider.js';

// ── Mapping helpers ──

function mapApprovalPolicy(level: PermissionLevel): ApprovalMode {
  switch (level) {
    case 'bypassPermissions': return 'never';
    case 'acceptEdits':       return 'on-request';
    case 'plan':
    case 'default':
    default:                  return 'untrusted';
  }
}

function mapSandboxMode(level: PermissionLevel, sandboxed: boolean): SandboxMode {
  if (level === 'plan') return 'read-only';
  if (sandboxed) return 'workspace-write';
  return 'danger-full-access';
}

// ── Streaming event consumer (shared between first turn and subsequent turns) ──

interface TurnContext {
  cb: StreamCardBuilder;
  callbacks: ProviderCallbacks;
  streamId: string;
  /** Resolves with thread_id when thread.started is received. */
  onThreadStarted?: (threadId: string) => void;
}

/**
 * Consume all events from a Codex runStreamed() call and emit card events.
 * Returns when the event stream is exhausted.
 */
async function consumeCodexStream(
  events: AsyncGenerator<ThreadEvent>,
  thread: Thread,
  ctx: TurnContext,
  signal?: AbortSignal,
): Promise<void> {
  const { cb, callbacks, streamId } = ctx;
  const emitCard = (event: CardEvent) => callbacks.emitCardEvent(event);

  let textBuffer = '';
  let bufferTimer: ReturnType<typeof setTimeout> | null = null;
  const tracker: TextTracker = { lastAssistantText: '', lastReasoningText: '' };
  let turnEndEmitted = false;

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

  const emitStreamEnd = (end: CardStreamEnd) => {
    if (turnEndEmitted) return;
    turnEndEmitted = true;
    callbacks.emitStreamEnd(end);
  };

  try {
    for await (const event of events) {
      if (signal?.aborted) break;

      switch (event.type) {
        case 'thread.started':
          cb.updateSessionId(event.thread_id);
          ctx.onThreadStarted?.(event.thread_id);
          break;

        case 'turn.started':
          break;

        case 'turn.completed': {
          flushText();
          const fin = cb.finalizeAssistantText();
          if (fin) emitCard(fin);
          emitStreamEnd({
            streamId,
            sessionId: thread.id ?? '',
            success: true,
            tokenUsage: event.usage
              ? { input: event.usage.input_tokens, output: event.usage.output_tokens }
              : undefined,
          });
          break;
        }

        case 'turn.failed': {
          flushText();
          const fin = cb.finalizeAssistantText();
          if (fin) emitCard(fin);
          emitStreamEnd({
            streamId,
            sessionId: thread.id ?? '',
            success: false,
            error: event.error.message,
          });
          break;
        }

        case 'item.started':
          routeItemStarted(event.item, cb, emitCard, flushText, bufferText, tracker);
          break;

        case 'item.updated':
          routeItemUpdated(event.item, cb, emitCard, bufferText, tracker);
          break;

        case 'item.completed':
          flushText();
          routeItemCompleted(event.item, cb, emitCard);
          break;

        case 'error':
          emitCard(cb.systemMessage(event.message, 'error'));
          break;
      }
    }
  } finally {
    if (bufferTimer) clearTimeout(bufferTimer);
  }

  // If the stream ended without turn.completed/turn.failed, emit a success end
  if (!turnEndEmitted) {
    flushText();
    const fin = cb.finalizeAssistantText();
    if (fin) emitCard(fin);
    emitStreamEnd({
      streamId,
      sessionId: thread.id ?? '',
      success: true,
    });
  }
}

// ── Item event routing ──

interface TextTracker {
  lastAssistantText: string;
  lastReasoningText: string;
}

function routeItemStarted(
  item: ThreadItem,
  cb: StreamCardBuilder,
  emitCard: (e: CardEvent) => void,
  flushText: () => void,
  bufferText: (t: string) => void,
  tracker: TextTracker,
): void {
  switch (item.type) {
    case 'reasoning':
      tracker.lastReasoningText = item.text;
      if (item.text) emitCard(cb.thinkingBlock(item.text));
      break;
    case 'agent_message':
      tracker.lastAssistantText = item.text;
      if (item.text) bufferText(item.text);
      break;
    case 'command_execution':
      flushText();
      emitCard(cb.toolUse('Bash', { command: item.command }, item.id));
      break;
    case 'file_change': {
      flushText();
      const paths = item.changes.map(c => c.path);
      const kinds = item.changes.map(c => c.kind);
      const toolName = kinds.every(k => k === 'add') ? 'Write' : 'Edit';
      emitCard(cb.toolUse(toolName, { files: paths }, item.id));
      break;
    }
    case 'mcp_tool_call':
      flushText();
      emitCard(cb.toolUse(
        `${item.server}:${item.tool}`,
        item.arguments as Record<string, unknown> ?? {},
        item.id,
      ));
      break;
    case 'web_search':
      flushText();
      emitCard(cb.toolUse('WebSearch', { query: item.query }, item.id));
      break;
    case 'error':
      emitCard(cb.systemMessage(item.message, 'error'));
      break;
  }
}

function routeItemUpdated(
  item: ThreadItem,
  cb: StreamCardBuilder,
  emitCard: (e: CardEvent) => void,
  bufferText: (t: string) => void,
  tracker: TextTracker,
): void {
  switch (item.type) {
    case 'agent_message': {
      const delta = item.text.slice(tracker.lastAssistantText.length);
      tracker.lastAssistantText = item.text;
      if (delta) bufferText(delta);
      break;
    }
    case 'command_execution': {
      const cardEvt = cb.toolResult(item.id, item.aggregated_output, item.status === 'failed');
      if (cardEvt) emitCard(cardEvt);
      break;
    }
    case 'reasoning': {
      const delta = item.text.slice(tracker.lastReasoningText.length);
      tracker.lastReasoningText = item.text;
      if (delta.trim()) emitCard(cb.thinkingBlock(delta));
      break;
    }
  }
}

function routeItemCompleted(
  item: ThreadItem,
  cb: StreamCardBuilder,
  emitCard: (e: CardEvent) => void,
): void {
  switch (item.type) {
    case 'agent_message': {
      // Finalize streaming text
      const fin = cb.finalizeAssistantText();
      if (fin) emitCard(fin);
      break;
    }
    case 'command_execution': {
      const resultText = item.aggregated_output
        + (item.exit_code != null ? `\n[exit code: ${item.exit_code}]` : '');
      const cardEvt = cb.toolResult(item.id, resultText, item.status === 'failed');
      if (cardEvt) emitCard(cardEvt);
      break;
    }
    case 'file_change': {
      const resultText = item.changes.map(c => `${c.kind}: ${c.path}`).join('\n');
      const cardEvt = cb.toolResult(item.id, resultText, item.status === 'failed');
      if (cardEvt) emitCard(cardEvt);
      break;
    }
    case 'mcp_tool_call': {
      let resultText = '';
      if (item.error) {
        resultText = `Error: ${item.error.message}`;
      } else if (item.result) {
        resultText = item.result.content
          ?.map((block: any) => block.text ?? JSON.stringify(block))
          .join('\n') ?? '';
      }
      const cardEvt = cb.toolResult(item.id, resultText, item.status === 'failed');
      if (cardEvt) emitCard(cardEvt);
      break;
    }
    case 'web_search': {
      const cardEvt = cb.toolResult(item.id, `Search: ${item.query}`, false);
      if (cardEvt) emitCard(cardEvt);
      break;
    }
  }
}

// ============================================================================
// CodexSdkSession — wraps a Codex Thread for the ProviderSession interface
// ============================================================================

class CodexSdkSession implements ProviderSession {
  public pendingStreamIds: string[] = [];

  private thread: Thread;
  private abortController: AbortController | null = null;
  private cardBuilder: StreamCardBuilder;
  private callbacks: ProviderCallbacks;
  private closed = false;

  constructor(args: {
    thread: Thread;
    cardBuilder: StreamCardBuilder;
    callbacks: ProviderCallbacks;
  }) {
    this.thread = args.thread;
    this.cardBuilder = args.cardBuilder;
    this.callbacks = args.callbacks;
  }

  get alive(): boolean {
    return !this.closed;
  }

  sendUserMessage(prompt: string): void {
    if (this.closed) return;
    const streamId = this.pendingStreamIds.shift() ?? `codex-stream-${Date.now()}`;
    void this.runTurn(prompt, streamId);
  }

  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  kill(): void {
    this.closed = true;
    this.interrupt();
  }

  /** Expose abort controller and streaming state for the initial turn (set from outside). */
  setAbortController(ac: AbortController): void { this.abortController = ac; }
  clearAbortController(): void { this.abortController = null; }

  private async runTurn(prompt: string, streamId: string): Promise<void> {
    if (this.closed) return;

    this.abortController = new AbortController();
    const cb = this.cardBuilder;

    cb.startNewTurn(streamId);
    cb.userMessage(prompt);

    try {
      const streamed = await this.thread.runStreamed(prompt, {
        signal: this.abortController.signal,
      });

      await consumeCodexStream(streamed.events, this.thread, {
        cb,
        callbacks: this.callbacks,
        streamId,
      }, this.abortController.signal);
    } catch (error) {
      const aborted = this.abortController?.signal.aborted;
      const sessionId = this.thread.id ?? '';
      const emitCard = (e: CardEvent) => this.callbacks.emitCardEvent(e);

      if (aborted) {
        emitCard(cb.systemMessage('User interrupted'));
        this.callbacks.emitStreamEnd({
          streamId, sessionId, success: false, interrupted: true,
        });
      } else {
        const msg = error instanceof Error ? error.message : 'Codex turn failed';
        console.error(`[codex-sdk] turn error:`, msg);
        this.callbacks.emitStreamEnd({
          streamId, sessionId, success: false, error: msg,
        });
      }
    } finally {
      this.abortController = null;
      await cb.persistCards().catch((err) => {
        console.error('[codex-sdk] failed to persist cards:', err);
      });
      cb.clearCards();
    }
  }
}

// ============================================================================
// CodexSdkProvider — implements CodingAgentProvider via @openai/codex-sdk
// ============================================================================

export class CodexSdkProvider implements CodingAgentProvider {
  readonly id = 'codex' as const;
  readonly historyMode = 'memory' as const;

  async startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const codex = new Codex({ apiKey: process.env.OPENAI_API_KEY });
    const threadOptions = buildThreadOptions(opts);
    const thread = codex.startThread(threadOptions);

    const session = new CodexSdkSession({
      thread,
      cardBuilder,
      callbacks,
    });

    // Run the first turn, waiting for thread.started to get the sessionId
    const sessionId = await this.runFirstTurn(
      thread, opts.prompt, opts.streamId, session, cardBuilder, callbacks,
    );

    return { sessionId, session };
  }

  async resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const codex = new Codex({ apiKey: process.env.OPENAI_API_KEY });
    const threadOptions = buildThreadOptions(opts);
    const thread = codex.resumeThread(opts.sessionId, threadOptions);

    cardBuilder.updateSessionId(opts.sessionId);

    const session = new CodexSdkSession({
      thread,
      cardBuilder,
      callbacks,
    });

    // Already have sessionId — fire and forget
    session.sendUserMessage(opts.prompt);

    return { sessionId: opts.sessionId, session };
  }

  /**
   * Run the first turn, awaiting `thread.started` for the sessionId.
   * The rest of the event stream processes in the background.
   */
  private runFirstTurn(
    thread: Thread,
    prompt: string,
    streamId: string,
    session: CodexSdkSession,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for Codex thread.started event'));
      }, 30_000);

      let resolved = false;

      const ac = new AbortController();
      session.setAbortController(ac);

      cardBuilder.startNewTurn(streamId);
      cardBuilder.userMessage(prompt);

      (async () => {
        try {
          const streamed = await thread.runStreamed(prompt, { signal: ac.signal });

          await consumeCodexStream(streamed.events, thread, {
            cb: cardBuilder,
            callbacks,
            streamId,
            onThreadStarted: (threadId) => {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve(threadId);
              }
            },
          }, ac.signal);
        } catch (error) {
          if (!resolved) {
            clearTimeout(timeout);
            reject(error);
            return;
          }
          // Already resolved — emit error to the stream
          const msg = error instanceof Error ? error.message : 'Codex turn failed';
          console.error(`[codex-sdk] initial turn error:`, msg);
          callbacks.emitStreamEnd({
            streamId,
            sessionId: thread.id ?? '',
            success: false,
            error: msg,
          });
        } finally {
          session.clearAbortController();
          await cardBuilder.persistCards().catch((err) => {
            console.error('[codex-sdk] failed to persist cards:', err);
          });
          cardBuilder.clearCards();
          // If thread.started never arrived but thread.id was set by the SDK
          if (!resolved) {
            clearTimeout(timeout);
            resolve(thread.id ?? `codex-${Date.now()}`);
          }
        }
      })();
    });
  }
}

function buildThreadOptions(opts: StartSessionOpts | ResumeSessionOpts): ThreadOptions {
  const model = 'model' in opts ? opts.model : undefined;
  return {
    model: model && !model.startsWith('claude-') ? model : undefined,
    workingDirectory: opts.cwd,
    sandboxMode: mapSandboxMode(opts.permissionLevel, opts.sandboxed),
    approvalPolicy: mapApprovalPolicy(opts.permissionLevel),
    skipGitRepoCheck: true,
  };
}
