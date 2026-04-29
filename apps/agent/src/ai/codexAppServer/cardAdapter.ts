import type { CardEvent, CardStreamEnd } from '@sumicom/quicksave-shared';

import type { StreamCardBuilder } from '../cardBuilder.js';
import type { ProviderCallbacks } from '../provider.js';

import type { CodexRpcClient } from './rpcClient.js';
import { TokenAccounting } from './tokenAccounting.js';
import type { ThreadItem } from './schema/generated/v2/ThreadItem.js';
import type { AgentMessageDeltaNotification } from './schema/generated/v2/AgentMessageDeltaNotification.js';
import type { CommandExecutionOutputDeltaNotification } from './schema/generated/v2/CommandExecutionOutputDeltaNotification.js';
import type { ReasoningSummaryTextDeltaNotification } from './schema/generated/v2/ReasoningSummaryTextDeltaNotification.js';
import type { ReasoningTextDeltaNotification } from './schema/generated/v2/ReasoningTextDeltaNotification.js';
import type { TurnCompletedNotification } from './schema/generated/v2/TurnCompletedNotification.js';
import type { TurnPlanUpdatedNotification } from './schema/generated/v2/TurnPlanUpdatedNotification.js';
import type { ItemStartedNotification } from './schema/generated/v2/ItemStartedNotification.js';
import type { ItemCompletedNotification } from './schema/generated/v2/ItemCompletedNotification.js';
import type { ServerRequestResolvedNotification } from './schema/generated/v2/ServerRequestResolvedNotification.js';
import type { ErrorNotification } from './schema/generated/v2/ErrorNotification.js';
import type { ThreadTokenUsageUpdatedNotification } from './schema/generated/v2/ThreadTokenUsageUpdatedNotification.js';
import type { CodexErrorInfo } from './schema/generated/v2/CodexErrorInfo.js';
import type { TurnStatus } from './schema/generated/v2/TurnStatus.js';

/** Debounce window for assistant text streaming — matches the SDK
 * provider's `FLUSH_INTERVAL_MS` so the user-visible "typing" cadence
 * stays identical between backends. */
const FLUSH_INTERVAL_MS = 150;
const TOOL_RESULT_TRUNCATE_LENGTH = 500; // matches cardBuilder.ts

/** How long to wait at `turn/completed` time for a matching
 * `thread/tokenUsage/updated` notification before giving up and emitting
 * an empty usage block. 250 ms matches plan §5.2. */
const TURN_USAGE_GRACE_MS = 250;

export interface CardAdapterContext {
  /** Stable session id for `CardEvent` envelopes. The card builder also
   * holds this; we keep a copy because most paths construct events
   * from the cardBuilder's helpers. */
  sessionId: string;
  /** The codex thread id. */
  threadId: string;
  /** The codex turn id, returned by `turn/start` and used for routing
   * notifications to this adapter. */
  turnId: string;
  /** Token accounting kept across turns by the session-level provider.
   * The adapter feeds it `thread/tokenUsage/updated` notifications and
   * pulls the per-turn delta on `turn/completed`. */
  tokens: TokenAccounting;
}

interface AdapterState {
  /** Pending text being debounced before flushing into
   * `cb.assistantText`. */
  textBuffer: string;
  textTimer: ReturnType<typeof setTimeout> | null;
  /** Number of chars already emitted to `cb.assistantText` per
   * agent_message itemId. Used to compute residual on
   * `item/completed` if started/deltas were missed. */
  agentMessageEmittedChars: Map<string, number>;
  /** Same accounting for reasoning summary text. Reasoning is rendered
   * as separate `thinking` cards per call, so we track per-item to
   * avoid double-rendering on completed. */
  reasoningEmittedChars: Map<string, number>;
  /** Accumulated command-execution output per itemId (chunks → final). */
  commandOutputBuffers: Map<string, string>;
  /** Set of error keys we've already surfaced this turn — dedup against
   * mid-turn `error` followed by `turn/completed { status: 'failed' }`
   * carrying the same message. Plan R3. */
  seenErrors: Set<string>;
  /** Set of file_change card ids already added — defensive against
   * duplicate item/started events. */
  fileChangeCardsAdded: Set<string>;
  /** Latest plan card id (`plan:${turnId}`) we have created. */
  planCardId: string | null;
  /** When `turn/completed` arrives, set so we stop processing further
   * notifications for this adapter. */
  turnEnded: boolean;
}

function emptyState(): AdapterState {
  return {
    textBuffer: '',
    textTimer: null,
    agentMessageEmittedChars: new Map(),
    reasoningEmittedChars: new Map(),
    commandOutputBuffers: new Map(),
    seenErrors: new Set(),
    fileChangeCardsAdded: new Set(),
    planCardId: null,
    turnEnded: false,
  };
}

/**
 * Subscribe to the RPC client's notification stream and translate v2
 * notifications into `StreamCardBuilder` mutator calls.
 *
 * Returns once `turn/completed` arrives for `ctx.turnId`. The caller
 * (provider's `runTurn`) handles user-cancel via `turn/interrupt`.
 *
 * IMPORTANT: this function is provider-only. It MUST NOT change the
 * `Card` / `CardEvent` shapes the cardBuilder emits — those are the
 * red-line contract. The dispatch table here matches plan §11's
 * resolved mapping; if a v2 notification needs a new card variant,
 * stop and add it to the cardBuilder API additively, then come back.
 */
export async function consumeAppServerStream(
  rpc: CodexRpcClient,
  cb: StreamCardBuilder,
  ctx: CardAdapterContext,
  callbacks: ProviderCallbacks,
): Promise<{ status: TurnStatus; error?: ErrorNotification['error'] }> {
  const state = emptyState();

  const emit = (event: CardEvent | null | undefined): void => {
    if (event) callbacks.emitCardEvent(event);
  };

  const flushText = (): void => {
    if (state.textBuffer) {
      emit(cb.assistantText(state.textBuffer));
      state.textBuffer = '';
    }
    if (state.textTimer) {
      clearTimeout(state.textTimer);
      state.textTimer = null;
    }
  };

  const bufferText = (delta: string): void => {
    if (!delta) return;
    state.textBuffer += delta;
    if (!state.textTimer) {
      state.textTimer = setTimeout(flushText, FLUSH_INTERVAL_MS);
    }
  };

  const errorKey = (err: { codexErrorInfo?: CodexErrorInfo | null; message?: string | null }): string =>
    `${stringifyErrorInfo(err.codexErrorInfo ?? null)}|${err.message ?? ''}`;

  const emitErrorOnce = (err: { codexErrorInfo?: CodexErrorInfo | null; message?: string | null }): void => {
    const key = errorKey(err);
    if (state.seenErrors.has(key)) return;
    state.seenErrors.add(key);
    const message = err.message ?? '(no message)';
    const event = cb.systemMessage(`Error: ${message}`, 'error');
    emit(event);
  };

  // Resolution promise — settled when turn/completed for our turnId arrives.
  let resolveResult: (value: { status: TurnStatus; error?: ErrorNotification['error'] }) => void;
  const result = new Promise<{ status: TurnStatus; error?: ErrorNotification['error'] }>((resolve) => {
    resolveResult = resolve;
  });

  const dispatch = (notification: { method: string; params: unknown }): void => {
    if (state.turnEnded) return;
    try {
      handleNotification(notification);
    } catch (err) {
      // Adapter must not crash the provider's run loop. Log and continue.
      emit(
        cb.systemMessage(
          `Internal adapter error on ${notification.method}: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        ),
      );
    }
  };

  const handleNotification = (notification: { method: string; params: unknown }): void => {
    switch (notification.method) {
      case 'turn/started':
        // No-op; provider already created the user card.
        return;

      case 'turn/completed': {
        const params = notification.params as TurnCompletedNotification;
        if (params.turn.id !== ctx.turnId) return;
        void finalize(params.turn.status, params.turn.error ?? undefined);
        return;
      }

      case 'thread/tokenUsage/updated': {
        const params = notification.params as ThreadTokenUsageUpdatedNotification;
        ctx.tokens.observe(params);
        return;
      }

      case 'item/started': {
        const params = notification.params as ItemStartedNotification;
        if (params.turnId !== ctx.turnId) return;
        handleItemStarted(params.item);
        return;
      }

      case 'item/completed': {
        const params = notification.params as ItemCompletedNotification;
        if (params.turnId !== ctx.turnId) return;
        handleItemCompleted(params.item);
        return;
      }

      case 'item/agentMessage/delta': {
        const params = notification.params as AgentMessageDeltaNotification;
        if (params.turnId !== ctx.turnId) return;
        if (!params.delta) return;
        const prev = state.agentMessageEmittedChars.get(params.itemId) ?? 0;
        state.agentMessageEmittedChars.set(params.itemId, prev + params.delta.length);
        bufferText(params.delta);
        return;
      }

      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const params = notification.params as
          | ReasoningSummaryTextDeltaNotification
          | ReasoningTextDeltaNotification;
        if (params.turnId !== ctx.turnId) return;
        const trimmed = params.delta?.trim();
        if (!trimmed) return;
        const prev = state.reasoningEmittedChars.get(params.itemId) ?? 0;
        state.reasoningEmittedChars.set(params.itemId, prev + params.delta.length);
        emit(cb.thinkingBlock(params.delta));
        return;
      }

      case 'item/reasoning/summaryPartAdded':
        // Boundary marker — flushing the current text buffer ensures
        // any in-flight assistant text is committed before the next
        // reasoning section opens.
        flushText();
        return;

      case 'item/commandExecution/outputDelta': {
        const params = notification.params as CommandExecutionOutputDeltaNotification;
        if (params.turnId !== ctx.turnId) return;
        const accumulated = (state.commandOutputBuffers.get(params.itemId) ?? '') + (params.delta ?? '');
        state.commandOutputBuffers.set(params.itemId, accumulated);
        // Don't emit on every chunk — that would cause O(N²) work in
        // the cardBuilder's truncation logic for long output. Instead
        // emit a debounced result update.
        emit(cb.toolResult(params.itemId, accumulated, false));
        return;
      }

      case 'turn/plan/updated': {
        const params = notification.params as TurnPlanUpdatedNotification;
        if (params.turnId !== ctx.turnId) return;
        handlePlanUpdated(params);
        return;
      }

      case 'serverRequest/resolved': {
        const params = notification.params as ServerRequestResolvedNotification;
        const requestIdStr = String(params.requestId);
        emit(cb.clearPendingInput(requestIdStr));
        return;
      }

      case 'error': {
        const params = notification.params as ErrorNotification;
        if (params.turnId && params.turnId !== ctx.turnId) return;
        if (params.willRetry) return; // server is retrying transparently
        emitErrorOnce(params.error);
        return;
      }

      case 'warning':
      case 'configWarning':
      case 'deprecationNotice': {
        const params = notification.params as { message?: string };
        const text = params?.message ?? `(${notification.method})`;
        emit(cb.systemMessage(text, 'warning'));
        return;
      }

      case 'guardianWarning': {
        // Guardian flagged the turn (safety / policy). Surface as a
        // warning system card so the user sees why an action was rejected.
        const params = notification.params as { threadId: string; message?: string };
        if (params.threadId !== ctx.threadId) return;
        emit(cb.systemMessage(`Guardian: ${params.message ?? '(no message)'}`, 'warning'));
        return;
      }

      case 'model/rerouted': {
        // Backend rerouted the request to a different model (cyber-safety
        // policy). Surface as info so the user understands why the model
        // running differs from the one they picked.
        const params = notification.params as {
          threadId: string;
          turnId: string;
          fromModel: string;
          toModel: string;
          reason: string;
        };
        if (params.turnId !== ctx.turnId) return;
        emit(
          cb.systemMessage(
            `Model rerouted: ${params.fromModel} → ${params.toModel} (${params.reason})`,
            'info',
          ),
        );
        return;
      }

      case 'model/verification': {
        // Backend asks for additional account verification (e.g.
        // trustedAccessForCyber). Surface as warning — the user has to
        // act on this outside the chat.
        const params = notification.params as {
          threadId: string;
          turnId: string;
          verifications: Array<{ kind?: string; message?: string }>;
        };
        if (params.turnId !== ctx.turnId) return;
        const messages = params.verifications
          .map((v) => v.message ?? v.kind ?? 'verification required')
          .join('; ');
        emit(cb.systemMessage(`Account verification: ${messages}`, 'warning'));
        return;
      }

      case 'mcpServer/startupStatus/updated': {
        // The user configured an MCP server that fails to start — they
        // need to know so they can fix it. `ready` and `starting` are
        // routine; we only surface the bad terminal states.
        const params = notification.params as {
          name: string;
          status: 'starting' | 'ready' | 'failed' | 'cancelled';
          error: string | null;
        };
        if (params.status === 'failed') {
          emit(
            cb.systemMessage(
              `MCP server "${params.name}" failed to start${params.error ? `: ${params.error}` : ''}`,
              'error',
            ),
          );
        }
        return;
      }

      case 'item/autoApprovalReview/started':
      case 'item/autoApprovalReview/completed': {
        // Phase 2: drop. Phase 5+ may render the auto-review subagent's
        // decision inline. Schema doesn't carry user-visible text yet,
        // so a system message would just say "review started" — noise.
        return;
      }

      case 'thread/closed':
      case 'thread/status/changed':
      case 'thread/name/updated':
      case 'thread/started':
      case 'thread/archived':
      case 'thread/unarchived':
      case 'thread/compacted':
      case 'item/fileChange/patchUpdated':
      case 'item/fileChange/outputDelta':
      case 'item/mcpToolCall/progress':
      case 'item/plan/delta':
      case 'turn/diff/updated':
      case 'rawResponseItem/completed':
      case 'item/commandExecution/terminalInteraction':
        // Phase 2: drop. Phase 5+ may surface some of these as new
        // card variants — see plan §1 N1.
        return;

      // Out-of-band notifications that don't pertain to a single turn:
      // account-level, fs watching, fuzzy file search, voice/realtime,
      // marketplace events, hook lifecycle, MCP OAuth completion. Silent
      // drop — surfacing them mid-turn would be noisy and they're better
      // routed via dedicated app-level subscriptions if a feature ever
      // needs them.
      case 'account/login/completed':
      case 'account/rateLimits/updated':
      case 'account/updated':
      case 'app/list/updated':
      case 'command/exec/outputDelta':
      case 'externalAgentConfig/import/completed':
      case 'fs/changed':
      case 'fuzzyFileSearch/sessionCompleted':
      case 'fuzzyFileSearch/sessionUpdated':
      case 'hook/started':
      case 'hook/completed':
      case 'mcpServer/oauthLogin/completed':
      case 'skills/changed':
      case 'thread/realtime/closed':
      case 'thread/realtime/error':
      case 'thread/realtime/itemAdded':
      case 'thread/realtime/outputAudio/delta':
      case 'thread/realtime/sdp':
      case 'thread/realtime/started':
      case 'thread/realtime/transcript/delta':
      case 'thread/realtime/transcript/done':
      case 'windows/worldWritableWarning':
      case 'windowsSandbox/setupCompleted':
        return;

      default:
        // Unknown notification — count, don't crash.
        return;
    }
  };

  const handleItemStarted = (item: ThreadItem): void => {
    switch (item.type) {
      case 'userMessage':
      case 'hookPrompt':
        // Provider already emitted the user card via cb.userMessage.
        return;

      case 'agentMessage': {
        // First chunk is usually empty; if non-empty it counts as a
        // delta we haven't yet seen.
        if (item.text) {
          state.agentMessageEmittedChars.set(item.id, item.text.length);
          bufferText(item.text);
        }
        return;
      }

      case 'reasoning': {
        // Reasoning summary/content arrives as deltas; nothing to do
        // at started.
        return;
      }

      case 'commandExecution': {
        flushText();
        emit(
          cb.toolUse('Bash', { command: item.command }, item.id),
        );
        return;
      }

      case 'fileChange': {
        flushText();
        emitFileChangeCards(item, false);
        return;
      }

      case 'mcpToolCall': {
        flushText();
        emit(
          cb.toolUse(`${item.server}:${item.tool}`, item.arguments as Record<string, unknown>, item.id),
        );
        return;
      }

      case 'webSearch': {
        // item/started fires with `item.query` empty (action is usually
        // `{ type: "other" }` at this stage) — Codex populates the real
        // query on item/completed. Use the structured `action` as a
        // best-effort fallback so the placeholder card shows SOMETHING
        // meaningful instead of "Search ?".
        flushText();
        emit(
          cb.toolUse('WebSearch', { query: extractWebSearchQuery(item) }, item.id),
        );
        return;
      }

      case 'dynamicToolCall': {
        flushText();
        const toolName = item.namespace ? `${item.namespace}:${item.tool}` : item.tool;
        emit(
          cb.toolUse(toolName, (item.arguments as Record<string, unknown>) ?? {}, item.id),
        );
        return;
      }

      case 'plan': {
        // Free-text plan item — drop to system info per plan R2 decision.
        emit(cb.systemMessage(`[plan] ${item.text || '(empty)'}`, 'info'));
        return;
      }

      case 'imageView': {
        // Codex showed an image to the model. Surface as system info with
        // the path so the user knows what was shared.
        emit(cb.systemMessage(`[image: ${item.path}]`, 'info'));
        return;
      }

      case 'imageGeneration': {
        // Started item — image not yet rendered. Show the prompt the
        // model is generating from. Result fields populate on completed.
        const prompt = item.revisedPrompt ?? '';
        emit(cb.systemMessage(`[generating image: ${prompt || '(no prompt)'}]`, 'info'));
        return;
      }

      case 'enteredReviewMode': {
        emit(cb.systemMessage(`Entered review mode: ${item.review}`, 'info'));
        return;
      }

      case 'exitedReviewMode': {
        emit(cb.systemMessage(`Exited review mode: ${item.review}`, 'info'));
        return;
      }

      case 'collabAgentToolCall': {
        // A sub-agent collaboration. Render as a tool_call card so the
        // PWA's existing tool view picks it up; the toolName is
        // `collab:${tool}` to namespace it away from real tools.
        flushText();
        const toolName = `collab:${item.tool}`;
        emit(
          cb.toolUse(
            toolName,
            {
              prompt: item.prompt ?? '',
              model: item.model ?? undefined,
              receiverThreadIds: item.receiverThreadIds,
            },
            item.id,
          ),
        );
        return;
      }

      case 'contextCompaction':
        emit(cb.systemMessage('Context compacted', 'compacted'));
        return;
    }
  };

  const handleItemCompleted = (item: ThreadItem): void => {
    switch (item.type) {
      case 'agentMessage': {
        flushText();
        const alreadyEmitted = state.agentMessageEmittedChars.get(item.id) ?? 0;
        const finalText = item.text ?? '';
        if (finalText.length > alreadyEmitted) {
          emit(cb.assistantText(finalText.slice(alreadyEmitted)));
          state.agentMessageEmittedChars.set(item.id, finalText.length);
        }
        const fin = cb.finalizeAssistantText();
        if (fin) emit(fin);
        return;
      }

      case 'reasoning': {
        // Defensive: if the deltas didn't fire, surface the final summary.
        // Fall back to `content` when summary is empty — some models emit
        // the raw chain-of-thought without producing the bullet summary.
        const alreadyEmitted = state.reasoningEmittedChars.get(item.id) ?? 0;
        if (alreadyEmitted > 0) return;
        const summary = (item.summary ?? []).join('\n').trim();
        if (summary) {
          emit(cb.thinkingBlock(summary));
          return;
        }
        const content = (item.content ?? []).join('\n').trim();
        if (content) {
          emit(cb.thinkingBlock(content));
        }
        return;
      }

      case 'commandExecution': {
        // Ensure the tool_use card exists (server might have skipped item/started).
        if (!cb.hasToolCard(item.id)) {
          emit(cb.toolUse('Bash', { command: item.command }, item.id));
        }
        const accumulated = state.commandOutputBuffers.get(item.id) ?? item.aggregatedOutput ?? '';
        const exitCodeSuffix = item.exitCode != null ? `\n[exit code: ${item.exitCode}]` : '';
        emit(
          cb.toolResult(item.id, accumulated + exitCodeSuffix, item.status === 'failed'),
        );
        state.commandOutputBuffers.delete(item.id);
        return;
      }

      case 'fileChange': {
        emitFileChangeCards(item, true);
        return;
      }

      case 'mcpToolCall': {
        if (!cb.hasToolCard(item.id)) {
          emit(
            cb.toolUse(
              `${item.server}:${item.tool}`,
              item.arguments as Record<string, unknown>,
              item.id,
            ),
          );
        }
        const failed = item.status === 'failed' || item.error != null;
        const text = mcpResultText(item);
        emit(cb.toolResult(item.id, text, failed));
        return;
      }

      case 'webSearch': {
        // ALWAYS re-emit toolUse on completion — `item.query` is empty at
        // item/started and only populated here, so a `hasToolCard` skip
        // would leave the placeholder card stuck on "Search ?". cardBuilder
        // dedups by toolUseId so re-emitting just patches the toolInput.
        const finalQuery = extractWebSearchQuery(item);
        emit(cb.toolUse('WebSearch', { query: finalQuery }, item.id));
        emit(cb.toolResult(item.id, `Search: ${finalQuery}`, false));
        return;
      }

      case 'dynamicToolCall': {
        const toolName = item.namespace ? `${item.namespace}:${item.tool}` : item.tool;
        if (!cb.hasToolCard(item.id)) {
          emit(
            cb.toolUse(toolName, (item.arguments as Record<string, unknown>) ?? {}, item.id),
          );
        }
        const text = stringifyDynamicToolResult(item);
        const failed = item.success === false;
        emit(cb.toolResult(item.id, text, failed));
        return;
      }

      case 'plan': {
        // No-op on completed (we already rendered as system info on started).
        return;
      }

      case 'imageGeneration': {
        // The status / savedPath only become real on completed; emit an
        // info system card linking to the saved file when present.
        const where = item.savedPath ? ` → ${item.savedPath}` : '';
        const failed = item.status !== 'completed' && item.status !== 'success';
        emit(
          cb.systemMessage(
            `[image ${failed ? 'generation failed' : 'generated'}: ${item.revisedPrompt ?? '(no prompt)'}]${where}`,
            failed ? 'error' : 'info',
          ),
        );
        return;
      }

      case 'collabAgentToolCall': {
        // Mirror mcpToolCall: ensure the card exists, then surface the
        // final state. Schema doesn't expose a result body so we
        // synthesize a one-liner from status + receivers.
        if (!cb.hasToolCard(item.id)) {
          emit(
            cb.toolUse(
              `collab:${item.tool}`,
              {
                prompt: item.prompt ?? '',
                model: item.model ?? undefined,
                receiverThreadIds: item.receiverThreadIds,
              },
              item.id,
            ),
          );
        }
        const failed = item.status === 'failed';
        emit(
          cb.toolResult(
            item.id,
            `${item.tool} → ${item.status}${item.receiverThreadIds.length ? ` (agents: ${item.receiverThreadIds.length})` : ''}`,
            failed,
          ),
        );
        return;
      }

      case 'userMessage':
      case 'hookPrompt':
      case 'imageView':
      case 'enteredReviewMode':
      case 'exitedReviewMode':
      case 'contextCompaction':
        return;
    }
  };

  const emitFileChangeCards = (
    item: Extract<ThreadItem, { type: 'fileChange' }>,
    emitResults: boolean,
  ): void => {
    const changes = item.changes ?? [];
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      const cardId = changes.length > 1 ? `${item.id}#${i}` : item.id;
      const filePath = extractFileChangePath(change) ?? '(unknown)';
      const kind = extractFileChangeKind(change);
      const { oldText, newText } = parseUnifiedDiff(extractFileChangeDiff(change));
      const toolInput: Record<string, unknown> =
        kind === 'Write'
          ? { file_path: filePath, content: newText }
          : { file_path: filePath, old_string: oldText, new_string: newText };
      // Always emit toolUse — first call adds the card, subsequent calls
      // patch toolInput via cardBuilder's dedup. item/started typically
      // carries an empty diff; item/completed carries the final patch,
      // so re-emitting refreshes the (-N/+M) counts and the rendered diff.
      emit(cb.toolUse(kind, toolInput, cardId));
      state.fileChangeCardsAdded.add(cardId);
      if (emitResults) {
        const failed = item.status === 'failed';
        emit(
          cb.toolResult(
            cardId,
            `${kind}: ${filePath}`.slice(0, TOOL_RESULT_TRUNCATE_LENGTH),
            failed,
          ),
        );
      }
    }
  };

  const handlePlanUpdated = (params: TurnPlanUpdatedNotification): void => {
    const todos = params.plan.map((step) => ({
      content: step.step,
      status: planStatusToTodoStatus(step.status),
    }));
    const cardId = `plan:${params.turnId}`;
    state.planCardId = cardId;
    emit(cb.toolUse('TodoWrite', { todos }, cardId));
    if (params.explanation) {
      emit(cb.systemMessage(params.explanation, 'info'));
    }
  };

  const finalize = async (
    status: TurnStatus,
    error: ErrorNotification['error'] | undefined,
  ): Promise<void> => {
    if (state.turnEnded) return;
    state.turnEnded = true;
    flushText();
    const fin = cb.finalizeAssistantText();
    if (fin) emit(fin);

    let usage: ReturnType<typeof TokenAccounting.toCardStreamEndUsage>;
    if (status === 'completed' || status === 'failed') {
      const observed = await ctx.tokens.awaitTurnUsage(ctx.turnId, TURN_USAGE_GRACE_MS);
      usage = TokenAccounting.toCardStreamEndUsage(observed);
    }

    if (status === 'failed' && error) {
      emitErrorOnce(error);
    }

    const streamEnd: CardStreamEnd = {
      sessionId: ctx.sessionId,
      success: status === 'completed',
      ...(status === 'interrupted' ? { interrupted: true } : {}),
      ...(status === 'failed' && error
        ? { error: formatError(error) }
        : {}),
      ...(usage ? { tokenUsage: usage } : {}),
    };
    callbacks.emitStreamEnd(streamEnd);
    ctx.tokens.releaseTurn(ctx.turnId);
    resolveResult({ status, error });
  };

  const unsubscribe = rpc.onNotification(dispatch);
  const unsubClose = rpc.onNotification(() => {
    /* noop placeholder for symmetry */
  });
  // Tear-down on transport close — emit a synthetic interrupted end if
  // the run wasn't already finalized.
  const closeFallback = (): void => {
    if (state.turnEnded) return;
    void finalize('interrupted', undefined);
  };
  // Note: we don't have a dedicated close listener API on RpcClient
  // for adapter-scoped lifecycle, so the provider drives this via its
  // own try/finally.
  void unsubClose; // placeholder; kept for future symmetry.

  try {
    return await result;
  } finally {
    unsubscribe();
    if (state.textTimer) clearTimeout(state.textTimer);
    void closeFallback;
  }
}

// ── helpers ──

function extractFileChangePath(change: unknown): string | null {
  if (typeof change !== 'object' || change === null) return null;
  const c = change as { path?: string; filePath?: string; file_path?: string };
  return c.path ?? c.filePath ?? c.file_path ?? null;
}

function extractFileChangeDiff(change: unknown): string {
  if (typeof change !== 'object' || change === null) return '';
  const c = change as { diff?: unknown };
  return typeof c.diff === 'string' ? c.diff : '';
}

/** Parse a Codex `FileUpdateChange.diff` (unified-diff format) into the
 *  removed/added text the EditToolView expects in `old_string`/`new_string`.
 *  Context lines and hunk/file headers are skipped — EditToolView prepends
 *  its own `-`/`+` markers, so we only feed it the actual changed lines. */
function parseUnifiedDiff(diff: string): { oldText: string; newText: string } {
  if (!diff) return { oldText: '', newText: '' };
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) continue;
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith('+')) newLines.push(line.slice(1));
    // Context lines (' ' prefix) and blanks are intentionally dropped.
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

function extractFileChangeKind(change: unknown): 'Edit' | 'Write' {
  if (typeof change !== 'object' || change === null) return 'Edit';
  const c = change as { kind?: unknown; type?: unknown };
  const k = (extractChangeDiscriminator(c.kind) || extractChangeDiscriminator(c.type)).toLowerCase();
  if (k === 'add' || k === 'create' || k === 'create_file' || k === 'write') return 'Write';
  return 'Edit';
}

function extractChangeDiscriminator(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return '';

  const record = value as Record<string, unknown>;
  for (const key of ['kind', 'type', 'tag']) {
    const nested = record[key];
    if (typeof nested === 'string') return nested;
  }

  const keys = Object.keys(record);
  return keys.length === 1 ? keys[0] : '';
}

/** Codex emits webSearch with `item.query` empty at item/started — the
 *  flat `query` field is only populated on item/completed. Even at completed
 *  it can stay empty when the model used a sub-action (`openPage` /
 *  `findInPage`). Fall back to whatever the structured `action` carries so
 *  the card never renders the bare "Search ?" placeholder. */
function extractWebSearchQuery(item: Extract<ThreadItem, { type: 'webSearch' }>): string {
  if (item.query) return item.query;
  const action = item.action;
  if (!action) return '';
  switch (action.type) {
    case 'search': {
      if (action.query) return action.query;
      if (action.queries && action.queries.length > 0) return action.queries.join(', ');
      return '';
    }
    case 'openPage':
      return action.url ?? '';
    case 'findInPage':
      return action.pattern
        ? (action.url ? `${action.pattern} (in ${action.url})` : action.pattern)
        : (action.url ?? '');
    case 'other':
      return '';
  }
}

function mcpResultText(item: Extract<ThreadItem, { type: 'mcpToolCall' }>): string {
  if (item.error) {
    if (typeof item.error === 'object' && 'message' in item.error) {
      return String((item.error as { message?: unknown }).message ?? 'MCP tool error');
    }
    return JSON.stringify(item.error);
  }
  const result = item.result;
  if (!result) return '(no result)';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && 'content' in result) {
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string);
      if (parts.length > 0) return parts.join('\n');
    }
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (structured !== undefined) return JSON.stringify(structured);
  }
  return JSON.stringify(result);
}

function stringifyDynamicToolResult(
  item: Extract<ThreadItem, { type: 'dynamicToolCall' }>,
): string {
  const items = item.contentItems ?? [];
  if (items.length === 0) return '(no result)';
  const parts: string[] = [];
  for (const ci of items) {
    if (typeof ci === 'object' && ci !== null && 'text' in ci) {
      const text = (ci as { text?: string }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  if (parts.length > 0) return parts.join('\n');
  return JSON.stringify(items);
}

function planStatusToTodoStatus(
  status: TurnPlanUpdatedNotification['plan'][number]['status'],
): 'pending' | 'in_progress' | 'completed' {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'inProgress':
      return 'in_progress';
    case 'completed':
      return 'completed';
  }
}

function stringifyErrorInfo(info: CodexErrorInfo | null): string {
  if (info == null) return '';
  if (typeof info === 'string') return info;
  return Object.keys(info)[0] ?? '';
}

function formatError(error: ErrorNotification['error']): string {
  const info = stringifyErrorInfo(error.codexErrorInfo ?? null);
  const prefix = info ? `[${info}] ` : '';
  return `${prefix}${error.message}${error.additionalDetails ? `\n${error.additionalDetails}` : ''}`;
}

// Re-export for tests that want to drive dispatch without spinning a real RPC client.
export type CardAdapterTestEntry = (notification: { method: string; params: unknown }) => void;
export type CardEventForTest = CardEvent;
