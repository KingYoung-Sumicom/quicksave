import { Codex } from '@openai/codex-sdk';
import type {
  Thread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  ApprovalMode,
  SandboxMode,
  ModelReasoningEffort,
} from '@openai/codex-sdk';
import type { CardEvent, CardStreamEnd } from '@sumicom/quicksave-shared';
import type { StreamCardBuilder } from './cardBuilder.js';
import { getEventStore } from '../storage/eventStore.js';
import type {
  CodingAgentProvider,
  ProviderCallbacks,
  ProviderSession,
  StartSessionOpts,
  ResumeSessionOpts,
  PermissionLevel,
} from './provider.js';

// ── Mapping helpers ──

/**
 * Codex permission preset → (approval_policy, sandbox_mode) tuple, matching
 * the official "common sandbox and approval combinations" table:
 *   https://developers.openai.com/codex/agent-approvals-security
 *
 * `auto-review` adds `approvals_reviewer = "auto_review"` to the Codex
 * instance config — handled separately in `startSession`/`resumeSession`.
 *
 * Falls back to legacy Claude-style values (`bypassPermissions`/`acceptEdits`
 * /`plan`/`default`) so sessions started before the codex picker existed
 * keep working.
 */
function resolveCodexPermissionPreset(
  level: PermissionLevel | string,
  sandboxed: boolean,
): {
  approvalPolicy: ApprovalMode;
  sandboxMode: SandboxMode;
  autoReview: boolean;
} {
  switch (level) {
    case 'read-only':
      return { approvalPolicy: 'on-request', sandboxMode: 'read-only', autoReview: false };
    case 'default':
      return { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', autoReview: false };
    case 'auto-review':
      return { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', autoReview: true };
    case 'full-access':
      return { approvalPolicy: 'never', sandboxMode: 'danger-full-access', autoReview: false };

    // Legacy Claude-style fallbacks. The sandbox toggle still applies for
    // these because old sessions persisted both axes independently.
    case 'bypassPermissions':
      return {
        approvalPolicy: 'never',
        sandboxMode: sandboxed ? 'workspace-write' : 'danger-full-access',
        autoReview: false,
      };
    case 'acceptEdits':
      return {
        approvalPolicy: 'on-request',
        sandboxMode: sandboxed ? 'workspace-write' : 'danger-full-access',
        autoReview: false,
      };
    case 'plan':
      return { approvalPolicy: 'untrusted', sandboxMode: 'read-only', autoReview: false };
    case 'default-claude':
    default:
      return {
        approvalPolicy: 'on-request',
        sandboxMode: sandboxed ? 'workspace-write' : 'danger-full-access',
        autoReview: false,
      };
  }
}

const CODEX_REASONING_EFFORTS = new Set<ModelReasoningEffort>([
  'minimal', 'low', 'medium', 'high', 'xhigh',
]);

function mapReasoningEffort(value: string | undefined): ModelReasoningEffort | undefined {
  if (!value) return undefined;
  return CODEX_REASONING_EFFORTS.has(value as ModelReasoningEffort)
    ? (value as ModelReasoningEffort)
    : undefined;
}

// Codex's TodoItem is `{ text, completed }`; the PWA's TodoWrite renderer
// expects Claude's shape `{ content, status }`. Without this, todo cards
// show only the default pending icon and no text.
function normalizeTodoItems(
  items: ReadonlyArray<{ text: string; completed: boolean }>,
): Array<{ content: string; status: 'completed' | 'pending' }> {
  return items.map((t) => ({
    content: t.text,
    status: t.completed ? 'completed' : 'pending',
  }));
}

type CodexFileChange = { path: string; kind: 'add' | 'delete' | 'update' };

// A Codex `file_change` item bundles every file in one patch; the PWA's
// Edit/Write views read `{ file_path }` (singular) and have no concept of a
// `files` array. Emit one card per change so each renders correctly and the
// per-file kind picks the right tool name.
function emitFileChangeCards(
  itemId: string,
  changes: ReadonlyArray<CodexFileChange>,
  status: 'completed' | 'failed',
  cb: StreamCardBuilder,
  emitCard: (e: CardEvent) => void,
  emitResult: boolean,
): void {
  const isFailure = status === 'failed';
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const cardId = changes.length === 1 ? itemId : `${itemId}#${i}`;
    const toolName: 'Write' | 'Edit' = change.kind === 'add' ? 'Write' : 'Edit';
    if (!cb.hasToolCard(cardId)) {
      emitCard(cb.toolUse(toolName, { file_path: change.path }, cardId));
    }
    if (emitResult) {
      const cardEvt = cb.toolResult(cardId, `${change.kind}: ${change.path}`, isFailure);
      if (cardEvt) emitCard(cardEvt);
    }
  }
}

/** Compute the new-text delta for an item whose `text` field is cumulative.
 *  When the item id differs from the previously-tracked one (e.g. a second
 *  agent_message item in the same turn) the previous length must NOT be used
 *  — otherwise the new message gets its leading characters sliced off. */
function takeAssistantDelta(
  item: { id: string; text: string },
  tracker: TextTracker,
): string {
  const isSameItem = tracker.lastAssistantItemId === item.id;
  const knownLength = isSameItem ? tracker.lastAssistantText.length : 0;
  const delta = item.text.slice(knownLength);
  tracker.lastAssistantText = item.text;
  tracker.lastAssistantItemId = item.id;
  return delta;
}

function takeReasoningDelta(
  item: { id: string; text: string },
  tracker: TextTracker,
): string {
  const isSameItem = tracker.lastReasoningItemId === item.id;
  const knownLength = isSameItem ? tracker.lastReasoningText.length : 0;
  const delta = item.text.slice(knownLength);
  tracker.lastReasoningText = item.text;
  tracker.lastReasoningItemId = item.id;
  return delta;
}

// `ErrorItem` has no status field — it's a one-shot. The SDK doesn't pin
// down which of started/updated/completed it arrives on, so we listen on all
// three and dedupe by id to avoid emitting the same message multiple times.
function emitErrorItemOnce(
  item: { id: string; message: string },
  cb: StreamCardBuilder,
  emitCard: (e: CardEvent) => void,
  tracker: TextTracker,
): void {
  if (tracker.emittedErrorIds.has(item.id)) return;
  tracker.emittedErrorIds.add(item.id);
  emitCard(cb.systemMessage(item.message, 'error'));
}

// ── Streaming event consumer (shared between first turn and subsequent turns) ──

interface TurnContext {
  cb: StreamCardBuilder;
  callbacks: ProviderCallbacks;
  streamId: string;
  /** Resolves with thread_id when thread.started is received. */
  onThreadStarted?: (threadId: string) => void;
  /** Codex reports `usage` cumulatively across the thread; the session keeps
   *  the running snapshot so we can compute per-turn deltas. The consumer
   *  reads it before turn.completed and writes the freshly observed
   *  cumulative back into it once the delta is emitted. Optional in tests
   *  that don't care about deltas — defaults to a zero snapshot. */
  prevCumulative?: CumulativeUsage;
}

interface CumulativeUsage {
  input: number;
  output: number;
  cachedInput: number;
}

/**
 * Consume all events from a Codex runStreamed() call and emit card events.
 * Returns when the event stream is exhausted.
 */
/** @internal Exported for testing. */
export async function consumeCodexStream(
  events: AsyncGenerator<ThreadEvent>,
  thread: Thread,
  ctx: TurnContext,
  signal?: AbortSignal,
): Promise<void> {
  const { cb, callbacks, streamId } = ctx;
  const emitCard = (event: CardEvent) => callbacks.emitCardEvent(event);

  let textBuffer = '';
  let bufferTimer: ReturnType<typeof setTimeout> | null = null;
  const tracker: TextTracker = {
    lastAssistantText: '',
    lastAssistantItemId: null,
    lastReasoningText: '',
    lastReasoningItemId: null,
    emittedErrorIds: new Set(),
  };
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
          let tokenUsage: CardStreamEnd['tokenUsage'];
          if (event.usage) {
            // Codex `usage` is thread-cumulative — convert to per-turn deltas
            // and update the running snapshot so the next turn lines up.
            const prev = ctx.prevCumulative ?? { input: 0, output: 0, cachedInput: 0 };
            const cumInput = event.usage.input_tokens;
            const cumOutput = event.usage.output_tokens;
            const cumCached = event.usage.cached_input_tokens ?? 0;
            tokenUsage = {
              input: Math.max(0, cumInput - prev.input),
              output: Math.max(0, cumOutput - prev.output),
              cumulativeInput: cumInput,
              cumulativeOutput: cumOutput,
              cumulativeCachedInput: cumCached,
            };
            prev.input = cumInput;
            prev.output = cumOutput;
            prev.cachedInput = cumCached;
          }
          emitStreamEnd({
            streamId,
            sessionId: thread.id ?? '',
            success: true,
            tokenUsage,
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
          routeItemCompleted(event.item, cb, emitCard, tracker);
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
  /** Cumulative text of the *current* agent_message item — the SDK delivers
   *  text cumulatively per item, so deltas come from `item.text.slice(length)`.
   *  Reset to "" whenever `lastAssistantItemId` changes so a fresh message
   *  doesn't slice itself by the previous message's length (which would chop
   *  off its leading characters). */
  lastAssistantText: string;
  lastAssistantItemId: string | null;
  lastReasoningText: string;
  lastReasoningItemId: string | null;
  /** IDs of ErrorItems already surfaced as system messages — see `emitErrorItemOnce`. */
  emittedErrorIds: Set<string>;
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
    case 'reasoning': {
      const delta = takeReasoningDelta(item, tracker);
      if (delta) emitCard(cb.thinkingBlock(delta));
      break;
    }
    case 'agent_message': {
      const delta = takeAssistantDelta(item, tracker);
      if (delta) bufferText(delta);
      break;
    }
    case 'command_execution':
      flushText();
      emitCard(cb.toolUse('Bash', { command: item.command }, item.id));
      break;
    case 'file_change': {
      flushText();
      emitFileChangeCards(item.id, item.changes, item.status, cb, emitCard, false);
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
    case 'todo_list':
      flushText();
      emitCard(cb.toolUse('TodoWrite', { todos: normalizeTodoItems(item.items) }, item.id));
      break;
    case 'error':
      emitErrorItemOnce(item, cb, emitCard, tracker);
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
      const delta = takeAssistantDelta(item, tracker);
      if (delta) bufferText(delta);
      break;
    }
    case 'command_execution': {
      const cardEvt = cb.toolResult(item.id, item.aggregated_output, item.status === 'failed');
      if (cardEvt) emitCard(cardEvt);
      break;
    }
    case 'reasoning': {
      const delta = takeReasoningDelta(item, tracker);
      if (delta.trim()) emitCard(cb.thinkingBlock(delta));
      break;
    }
    case 'todo_list': {
      // TodoWrite's card body reads from the tool input, which we update via
      // a fresh toolUse call (the cardBuilder dedupes by toolUseId and patches
      // in place).
      const cardEvt = cb.toolUse('TodoWrite', { todos: normalizeTodoItems(item.items) }, item.id);
      if (cardEvt) emitCard(cardEvt);
      break;
    }
    case 'error':
      emitErrorItemOnce(item, cb, emitCard, tracker);
      break;
    case 'web_search':
      // Codex emits web_search at item.started with an empty query and only
      // populates `query` later via item.updated. Without this case the card
      // shows the empty-query fallback ("?"). cardBuilder dedupes by id so
      // re-emitting the toolUse just patches the input in place.
      emitCard(cb.toolUse('WebSearch', { query: item.query }, item.id));
      break;
    // file_change / mcp_tool_call have no meaningful intermediate state —
    // they're surfaced once at started or completed. Intentionally omitted.
  }
}

function routeItemCompleted(
  item: ThreadItem,
  cb: StreamCardBuilder,
  emitCard: (e: CardEvent) => void,
  tracker: TextTracker,
): void {
  switch (item.type) {
    case 'agent_message': {
      // Defensive: emit any text not yet surfaced via item.started/updated.
      // Codex's experimental-json can deliver agent_message as a single
      // item.completed with no prior started/updated — without this, the
      // model's narration silently disappears.
      const delta = takeAssistantDelta(item, tracker);
      if (delta) emitCard(cb.assistantText(delta));
      const fin = cb.finalizeAssistantText();
      if (fin) emitCard(fin);
      break;
    }
    case 'command_execution': {
      // Ensure the tool card exists — some streams skip item.started.
      if (!cb.hasToolCard(item.id)) {
        emitCard(cb.toolUse('Bash', { command: item.command }, item.id));
      }
      const resultText = item.aggregated_output
        + (item.exit_code != null ? `\n[exit code: ${item.exit_code}]` : '');
      const cardEvt = cb.toolResult(item.id, resultText, item.status === 'failed');
      if (cardEvt) emitCard(cardEvt);
      break;
    }
    case 'file_change': {
      // file_change is typically emitted only at item.completed per SDK docs,
      // but the tests show it can also arrive via item.started. The helper
      // creates per-file Edit/Write cards (deduped by id) so either path works.
      emitFileChangeCards(item.id, item.changes, item.status, cb, emitCard, true);
      break;
    }
    case 'mcp_tool_call': {
      if (!cb.hasToolCard(item.id)) {
        emitCard(cb.toolUse(
          `${item.server}:${item.tool}`,
          item.arguments as Record<string, unknown> ?? {},
          item.id,
        ));
      }
      let resultText = '';
      if (item.error) {
        resultText = `Error: ${item.error.message}`;
      } else if (item.result) {
        resultText = item.result.content
          ?.map((block: any) => block.text ?? JSON.stringify(block))
          .join('\n') ?? '';
        // Some MCP servers return only structured_content (no text blocks);
        // fall back so the result card isn't empty.
        if (!resultText && item.result.structured_content !== undefined) {
          resultText = JSON.stringify(item.result.structured_content);
        }
      }
      const cardEvt = cb.toolResult(item.id, resultText, item.status === 'failed');
      if (cardEvt) emitCard(cardEvt);
      break;
    }
    case 'web_search': {
      if (!cb.hasToolCard(item.id)) {
        emitCard(cb.toolUse('WebSearch', { query: item.query }, item.id));
      }
      const cardEvt = cb.toolResult(item.id, `Search: ${item.query}`, false);
      if (cardEvt) emitCard(cardEvt);
      break;
    }
    case 'reasoning': {
      // Like agent_message: emit any un-surfaced text defensively.
      const delta = takeReasoningDelta(item, tracker);
      if (delta.trim()) emitCard(cb.thinkingBlock(delta));
      break;
    }
    case 'todo_list': {
      // Patch-or-create the TodoWrite card with the final list.
      emitCard(cb.toolUse('TodoWrite', { todos: normalizeTodoItems(item.items) }, item.id));
      const completedCount = item.items.filter((t) => t.completed).length;
      const resultText = `${completedCount}/${item.items.length} completed`;
      const cardEvt = cb.toolResult(item.id, resultText, false);
      if (cardEvt) emitCard(cardEvt);
      break;
    }
    case 'error':
      emitErrorItemOnce(item, cb, emitCard, tracker);
      break;
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
  /** Running thread-cumulative usage; updated in-place on every turn.completed
   *  so each turn's tokenUsage is reported as a per-turn delta. Seeded from
   *  prior persisted turns on resume so deltas survive a daemon restart. */
  public readonly prevCumulative: CumulativeUsage;

  constructor(args: {
    thread: Thread;
    cardBuilder: StreamCardBuilder;
    callbacks: ProviderCallbacks;
    seedCumulative?: CumulativeUsage;
  }) {
    this.thread = args.thread;
    this.cardBuilder = args.cardBuilder;
    this.callbacks = args.callbacks;
    this.prevCumulative = args.seedCumulative
      ? { ...args.seedCumulative }
      : { input: 0, output: 0, cachedInput: 0 };
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
        prevCumulative: this.prevCumulative,
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
    const preset = resolveCodexPermissionPreset(opts.permissionLevel, opts.sandboxed);
    const codex = makeCodex(preset.autoReview);
    const threadOptions = buildThreadOptions(opts, preset);
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
    const preset = resolveCodexPermissionPreset(opts.permissionLevel, opts.sandboxed);
    const codex = makeCodex(preset.autoReview);
    const threadOptions = buildThreadOptions(opts, preset);
    const thread = codex.resumeThread(opts.sessionId, threadOptions);

    cardBuilder.updateSessionId(opts.sessionId);

    const session = new CodexSdkSession({
      thread,
      cardBuilder,
      callbacks,
      seedCumulative: loadCumulativeSeed(opts.sessionId),
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
            prevCumulative: session.prevCumulative,
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

/** Load the cumulative usage we last persisted for this thread, so a freshly
 *  resumed session continues to emit per-turn deltas instead of treating the
 *  next cumulative report as if the thread had started from zero. Falls back
 *  to legacy turns recorded before `cumulativeInputTokens` was introduced —
 *  back then we stored the raw cumulative as `inputTokens`, so that field is
 *  still a usable seed when the cumulative one is missing. */
function loadCumulativeSeed(sessionId: string): CumulativeUsage | undefined {
  const last = getEventStore().getLastTurn(sessionId);
  if (!last) return undefined;
  const cumInput = last.cumulativeInputTokens ?? last.inputTokens;
  const cumOutput = last.cumulativeOutputTokens ?? last.outputTokens;
  const cumCached = last.cumulativeCachedInputTokens ?? 0;
  if (!cumInput && !cumOutput && !cumCached) return undefined;
  return { input: cumInput, output: cumOutput, cachedInput: cumCached };
}

/** Build a Codex SDK instance, applying `approvals_reviewer = "auto_review"`
 *  via the SDK's `config` override when the chosen preset wants the
 *  auto-reviewer subagent. The SDK has no per-thread reviewer, so this is
 *  set per-instance — fine because each session creates its own Codex. */
function makeCodex(autoReview: boolean): Codex {
  return new Codex({
    apiKey: process.env.OPENAI_API_KEY,
    ...(autoReview ? { config: { approvals_reviewer: 'auto_review' } } : {}),
  });
}

function buildThreadOptions(
  opts: StartSessionOpts | ResumeSessionOpts,
  preset: { approvalPolicy: ApprovalMode; sandboxMode: SandboxMode },
): ThreadOptions {
  const model = 'model' in opts ? opts.model : undefined;
  return {
    model: model && !model.startsWith('claude-') ? model : undefined,
    workingDirectory: opts.cwd,
    sandboxMode: preset.sandboxMode,
    approvalPolicy: preset.approvalPolicy,
    modelReasoningEffort: mapReasoningEffort(opts.reasoningEffort),
    skipGitRepoCheck: true,
  };
}
