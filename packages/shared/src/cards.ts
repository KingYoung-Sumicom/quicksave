// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
// ============================================================================
// Card-based Message Architecture
//
// All SDK-specific aggregation happens on the agent side.
// The PWA receives a flat ordered array of Cards and renders them.
// This abstraction supports multiple coding agent SDKs (Claude, Cursor, Aider, etc.)
// ============================================================================

/**
 * Stable card identifier assigned by the agent.
 * Format: `${sessionId}:${sequenceNumber}` or for tool calls `${sessionId}:tu:${toolUseId}`
 */
export type CardId = string;

// ── Pending Input (permission / question) ────────────────────────────────

export interface PendingInputAttachment {
  sessionId: string;
  requestId: string;
  inputType: 'permission' | 'question';
  title: string;
  message?: string;
  options?: PendingInputOption[];
}

export interface PendingInputOption {
  key: string;
  label: string;
  description?: string;
}

// ── Card Base ─────────────────────────────────────────────────────────────

export interface CardBase {
  id: CardId;
  timestamp: number;
  /** Permission prompt or question attached to this card (agent-side attached). */
  pendingInput?: PendingInputAttachment;
}

// ── Card Variants ─────────────────────────────────────────────────────────

export interface UserCard extends CardBase {
  type: 'user';
  text: string;
  /** Files / long-pasted text the user attached. Carries metadata only (id +
   *  kind + mime + name + size). Bytes are fetched on demand via
   *  `attachment:fetch` and cached PWA-side, so card snapshots stay small. */
  attachments?: import('./attachments.js').AttachmentMetadata[];
}

export interface AssistantTextCard extends CardBase {
  type: 'assistant_text';
  text: string;
  /** True while streaming deltas are still arriving for this card. */
  streaming?: boolean;
}

export interface ThinkingCard extends CardBase {
  type: 'thinking';
  text: string;
}

export interface ToolCallCard extends CardBase {
  type: 'tool_call';
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  /** Paired result — populated by the agent when tool_result arrives. */
  result?: ToolCallResult;
  /**
   * AskUserQuestion only: map of question text → answer text the user picked.
   * Populated by the agent the moment the user responds, so the UI can show
   * selections without waiting for (or parsing) the CLI's tool_result.
   */
  answers?: Record<string, string>;
}

export interface ToolCallResult {
  content: string;
  isError: boolean;
  truncated: boolean;
}

export interface SubagentToolCall {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  result?: { content: string; isError: boolean };
}

export interface SubagentCard extends CardBase {
  type: 'subagent';
  description: string;
  /** Parent Agent tool_use_id — positional anchor in the card sequence. */
  toolUseId: string;
  /** SDK task_id — consistent across streaming and history. */
  agentId: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  summary?: string;
  toolUseCount: number;
  lastToolName?: string;
  /** Subagent type from Agent tool input (e.g. "Explore", "Plan", "general-purpose"). */
  subagentType?: string;
  /** Requested model override from Agent tool input (e.g. "sonnet", "opus", "haiku"). */
  requestedModel?: string;
  /** Actual model used by the subagent. Reserved — not yet available from CLI. */
  actualModel?: string;
  /** Initial prompt given to the subagent. */
  prompt?: string;
  /** Tool calls made by the subagent, nested here instead of top-level cards. */
  toolCalls?: SubagentToolCall[];
}

export type SystemCardSubtype = 'compacted' | 'cost' | 'error' | 'info' | 'warning';

/**
 * Optional structured payload for system cards that carry more than a one-line
 * string. `text` stays populated as a human-readable fallback (debug logs,
 * non-PWA consumers); `meta` lets the PWA render something richer — a duration
 * badge, a collapsible hook summary — instead of printing the raw subtype name.
 *
 * Sourced from Claude's own `type:"system"` JSONL entries:
 *   - `turn_duration`    → `{ durationMs, messageCount }`
 *   - `stop_hook_summary`→ `{ hooks[], errors[], level, preventedContinuation, stopReason }`
 */
export type SystemCardMeta =
  | {
      kind: 'turn_duration';
      /** Wall-clock duration of the turn in milliseconds. */
      durationMs: number;
      /** Messages exchanged during the turn. */
      messageCount: number;
    }
  | {
      kind: 'stop_hook_summary';
      /** One entry per Stop hook that ran, with its command and wall-clock time. */
      hooks: { command: string; durationMs: number }[];
      /** Non-blocking hook error summaries (stderr). Empty when all hooks succeeded. */
      errors: string[];
      /** Claude's severity hint, e.g. "suggestion". */
      level?: string;
      /** True if a hook blocked Claude from continuing the turn. */
      preventedContinuation: boolean;
      /** Reason string from a blocking hook, when present. */
      stopReason?: string;
    };

export interface SystemCard extends CardBase {
  type: 'system';
  text: string;
  subtype?: SystemCardSubtype;
  /** Structured payload for rich rendering; see `SystemCardMeta`. */
  meta?: SystemCardMeta;
}

export interface GeneratedImageCard extends CardBase {
  type: 'generated_image';
  prompt: string;
  status: 'running' | 'completed' | 'failed';
  savedPath?: string;
}

export interface ArtifactCard extends CardBase {
  type: 'artifact';
  artifact: import('./artifacts.js').MarkdownArtifactRef;
}

/**
 * Inline action card emitted by the agent when it detects the session is
 * stuck on a "poison" turn the API will keep rejecting (e.g. an oversized
 * PDF replayed every resume). The PWA renders an explanation + a one-tap
 * button that sends a recovery prompt through the normal send path.
 *
 * `action` is the recovery primitive to invoke. Currently only `compact`
 * exists — the SDK already exposes `/compact` as a non-interactive slash
 * command, so the PWA just sends the literal string and the SDK does the
 * rest. Future: could add `clear`, `rewind`, etc. without changing the
 * card shape.
 *
 * `invoked` is purely a local UI hint for the PWA to disable its own
 * button after click; the agent never patches it. Persistence: these
 * cards live only in the in-memory cardBuilder, not the JSONL — once a
 * turn is over they vanish from history (which is the desired behavior:
 * after recovery, the offer no longer needs to surface on reload).
 */
export interface RecoverySuggestedCard extends CardBase {
  type: 'recovery_suggested';
  /** Human-readable explanation, e.g. "An oversized PDF is jamming this conversation." */
  reason: string;
  /** Recovery primitive. `compact` sends `/compact` through the regular send path. */
  action: 'compact';
  /** Button label, e.g. "Compact to recover". */
  label: string;
}

export type Card =
  | UserCard
  | AssistantTextCard
  | ThinkingCard
  | ToolCallCard
  | SubagentCard
  | SystemCard
  | GeneratedImageCard
  | ArtifactCard
  | RecoverySuggestedCard;

// ── Card Events (wire protocol: agent → PWA) ─────────────────────────────

export interface CardAddEvent {
  type: 'add';
  sessionId: string;
  card: Card;
  /** Insert after this card ID. Undefined = append to end. */
  afterCardId?: CardId;
}

export interface CardUpdateEvent {
  type: 'update';
  sessionId: string;
  cardId: CardId;
  /**
   * Partial card fields to merge (only changed fields sent).
   *
   * Wire convention: `null` means "delete this key". JSON.stringify drops
   * `undefined`, so we use `null` as the clear sentinel (e.g. clearing
   * `pendingInput` after permission resolution). Receivers must delete
   * null-valued keys after spreading the patch.
   */
  patch: Record<string, unknown>;
}

export interface CardAppendTextEvent {
  type: 'append_text';
  sessionId: string;
  cardId: CardId;
  text: string;
}

export interface CardRemoveEvent {
  type: 'remove';
  sessionId: string;
  cardId: CardId;
}

export type CardEvent = CardAddEvent | CardUpdateEvent | CardAppendTextEvent | CardRemoveEvent;

// ── Pending Input with matching context (for history response) ─────────────

/** PendingInputAttachment enriched with card-matching hints (toolUseId, agentId, toolName). */
export interface PendingInputWithContext extends PendingInputAttachment {
  toolName?: string;
  toolUseId?: string;
  agentId?: string;
}

// ── History Response (agent → PWA) ────────────────────────────────────────

export interface CardHistoryResponse {
  cards: Card[];
  total: number;
  hasMore: boolean;
  error?: string;
  /** Pending permission/question requests for this session (agent-authoritative). */
  pendingInputs?: PendingInputWithContext[];
  /** Session title / subject (set via the UpdateSessionStatus MCP tool or derived from session registry). */
  title?: string;
}

// ── Session cards bus subscription (see /sessions/:sessionId/cards) ───────

/**
 * Update frame for the `/sessions/:sessionId/cards` message-bus path.
 * Snapshot is `CardHistoryResponse` (offset=0 card history + pendingInput
 * overlay + title). Updates carry either an incremental `CardEvent` or the
 * final `CardStreamEnd` of a turn; the PWA applies them to its card store.
 */
export type SessionCardsUpdate =
  | { kind: 'card'; event: CardEvent }
  | { kind: 'stream-end'; result: CardStreamEnd };

// ── Stream End ────────────────────────────────────────────────────────────

export interface CardStreamEnd {
  sessionId: string;
  success: boolean;
  error?: string;
  /** True when the turn was stopped by user cancel/interrupt */
  interrupted?: boolean;
  totalCostUsd?: number;
  tokenUsage?: {
    input: number;
    output: number;
    /** Tokens written into the prompt cache this turn. */
    cacheCreation?: number;
    /** Tokens read from the prompt cache this turn. */
    cacheRead?: number;
    /** Context window reported by the provider for the active model. Codex
     *  surfaces this via `thread/tokenUsage/updated.modelContextWindow`. */
    modelContextWindow?: number;
    /** Codex reports usage as session-cumulative; the provider converts to
     *  per-turn deltas above and surfaces the raw cumulative here so the
     *  agent can persist it and seed `prev` after a daemon restart. */
    cumulativeInput?: number;
    cumulativeOutput?: number;
    cumulativeCachedInput?: number;
  };
}
