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
}

export type SystemCardSubtype = 'compacted' | 'cost' | 'error' | 'info' | 'warning';

export interface SystemCard extends CardBase {
  type: 'system';
  text: string;
  subtype?: SystemCardSubtype;
}

export type Card =
  | UserCard
  | AssistantTextCard
  | ThinkingCard
  | ToolCallCard
  | SubagentCard
  | SystemCard;

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
    /** Tokens written into the prompt cache this turn (Claude only). */
    cacheCreation?: number;
    /** Tokens read from the prompt cache this turn (Claude only). */
    cacheRead?: number;
    /** Codex reports usage as session-cumulative; the provider converts to
     *  per-turn deltas above and surfaces the raw cumulative here so the
     *  agent can persist it and seed `prev` after a daemon restart. */
    cumulativeInput?: number;
    cumulativeOutput?: number;
    cumulativeCachedInput?: number;
  };
}
