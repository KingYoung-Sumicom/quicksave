import type {
  Card,
  CardId,
  CardEvent,
  CardAddEvent,
  CardUpdateEvent,
  CardAppendTextEvent,
  CardRemoveEvent,
  CardHistoryResponse,
  ToolCallCard,
  SubagentCard,
  PendingInputAttachment,
} from '@sumicom/quicksave-shared';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

const TOOL_RESULT_TRUNCATE_LENGTH = 500;

// ── Direct JSONL file reading (replaces SDK getSessionMessages/listSubagents) ──

function encodeCwdPath(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function claudeProjectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwdPath(cwd));
}

async function readMessagesFromJSONL(sessionId: string, cwd: string): Promise<any[]> {
  const p = join(claudeProjectDir(cwd), sessionId + '.jsonl');
  if (!existsSync(p)) return [];
  const content = await readFile(p, 'utf-8');
  const msgs: any[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.type === 'user' || m.type === 'assistant' || m.type === 'system') msgs.push(m);
    } catch { /* skip */ }
  }
  return msgs;
}

async function listSubagentIdsFromDisk(sessionId: string, cwd: string): Promise<string[]> {
  const d = join(claudeProjectDir(cwd), sessionId, 'subagents');
  if (!existsSync(d)) return [];
  try {
    return (await readdir(d)).filter(f => f.endsWith('.meta.json')).map(f => f.replace('.meta.json', ''));
  } catch { return []; }
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
// StreamCardBuilder — streaming session, emits CardEvents
// ============================================================================

export class StreamCardBuilder {
  private sessionId: string;
  private streamId: string;
  private seq = 0;
  private cards = new Map<CardId, Card>();
  /** tool_use_id → CardId, for pairing tool_result to ToolCallCard */
  private toolUseIdToCardId = new Map<string, CardId>();
  /** agentId (task_id) → CardId, for matching subagent updates */
  private agentIdToCardId = new Map<string, CardId>();
  /** Cards created for subagent permissions — removed after resolution. */
  private ephemeralCards = new Set<CardId>();
  /** Current streaming assistant_text card (for append_text events) */
  private currentTextCardId: CardId | null = null;

  constructor(sessionId: string, streamId: string) {
    this.sessionId = sessionId;
    this.streamId = streamId;
  }

  updateSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** Start a new turn: update streamId and reset per-turn state, keep accumulated cards. */
  startNewTurn(streamId: string): void {
    this.streamId = streamId;
    this.currentTextCardId = null;
  }

  private nextId(): CardId {
    return `${this.sessionId}:${this.streamId}:${++this.seq}`;
  }

  private addEvent(card: Card, afterCardId?: CardId): CardAddEvent {
    this.cards.set(card.id, card);
    return { type: 'add', streamId: this.streamId, sessionId: this.sessionId, card, afterCardId };
  }

  private updateEvent(cardId: CardId, patch: Record<string, unknown>): CardUpdateEvent {
    const existing = this.cards.get(cardId);
    if (existing) {
      Object.assign(existing, patch);
    }
    return { type: 'update', streamId: this.streamId, sessionId: this.sessionId, cardId, patch };
  }

  private appendTextEvent(cardId: CardId, text: string): CardAppendTextEvent {
    const existing = this.cards.get(cardId);
    if (existing && 'text' in existing) {
      (existing as any).text += text;
    }
    return { type: 'append_text', streamId: this.streamId, sessionId: this.sessionId, cardId, text };
  }

  private removeEvent(cardId: CardId): CardRemoveEvent {
    this.cards.delete(cardId);
    return { type: 'remove', streamId: this.streamId, sessionId: this.sessionId, cardId };
  }

  // ── Public: produce CardEvents from SDK data ────────────────────────────

  userMessage(text: string): CardEvent {
    this.currentTextCardId = null;
    const card: Card = { type: 'user', id: this.nextId(), timestamp: Date.now(), text };
    return this.addEvent(card);
  }

  thinkingBlock(text: string): CardEvent {
    this.currentTextCardId = null;
    const card: Card = { type: 'thinking', id: this.nextId(), timestamp: Date.now(), text };
    return this.addEvent(card);
  }

  /**
   * Append text to current assistant_text card, or create a new one.
   * Returns append_text event (hot path) or add event (new card).
   */
  assistantText(text: string): CardEvent {
    if (this.currentTextCardId) {
      return this.appendTextEvent(this.currentTextCardId, text);
    }
    const id = this.nextId();
    const card: Card = { type: 'assistant_text', id, timestamp: Date.now(), text, streaming: true };
    this.currentTextCardId = id;
    return this.addEvent(card);
  }

  /** Mark the current assistant_text card as done streaming. */
  finalizeAssistantText(): CardEvent | null {
    if (!this.currentTextCardId) return null;
    const id = this.currentTextCardId;
    this.currentTextCardId = null;
    return this.updateEvent(id, { streaming: false });
  }

  /**
   * Handle tool_use block from SDK stream.
   * If the card was already pre-created via `toolCallFromPermission()`, confirm it.
   * Otherwise create a new ToolCallCard.
   */
  toolUse(toolName: string, toolInput: Record<string, unknown>, toolUseId: string): CardEvent {
    this.currentTextCardId = null;

    // Check if card was pre-created from canUseTool
    const existingCardId = this.toolUseIdToCardId.get(toolUseId);
    if (existingCardId) {
      // Confirm with real data (input may differ if updatedInput was returned)
      return this.updateEvent(existingCardId, { toolInput });
    }

    const id = this.nextId();
    const card: ToolCallCard = {
      type: 'tool_call', id, timestamp: Date.now(),
      toolName, toolInput, toolUseId,
    };
    this.toolUseIdToCardId.set(toolUseId, id);
    return this.addEvent(card);
  }

  /**
   * Pre-create a ToolCallCard from canUseTool (fires before tool_use stream event).
   * This eliminates the synthetic message hack.
   */
  toolCallFromPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
    pendingInput: PendingInputAttachment,
    /** Ephemeral cards are removed after permission is resolved (subagent permissions). */
    ephemeral = false,
  ): CardEvent {
    this.currentTextCardId = null;

    // If the card was already created by the assistant message's tool_use block
    // (which arrives in the stream BEFORE canUseTool fires), update it with pendingInput.
    const existingCardId = this.toolUseIdToCardId.get(toolUseId);
    if (existingCardId) {
      if (ephemeral) this.ephemeralCards.add(existingCardId);
      return this.updateEvent(existingCardId, { pendingInput });
    }

    const id = this.nextId();
    const card: ToolCallCard = {
      type: 'tool_call', id, timestamp: Date.now(),
      toolName, toolInput, toolUseId, pendingInput,
    };
    this.toolUseIdToCardId.set(toolUseId, id);
    if (ephemeral) this.ephemeralCards.add(id);
    return this.addEvent(card);
  }

  /** Attach a pending input to a subagent card (subagent permission). */
  attachPendingToSubagent(agentId: string, pendingInput: PendingInputAttachment): CardEvent | null {
    const cardId = this.agentIdToCardId.get(agentId);
    if (!cardId) return null;
    return this.updateEvent(cardId, { pendingInput });
  }

  /** Clear pending input from a card. Ephemeral cards are removed entirely. */
  clearPendingInput(requestId: string): CardEvent | null {
    for (const [, card] of this.cards) {
      if (card.pendingInput?.requestId === requestId) {
        if (this.ephemeralCards.has(card.id)) {
          this.ephemeralCards.delete(card.id);
          return this.removeEvent(card.id);
        }
        return this.updateEvent(card.id, { pendingInput: undefined });
      }
    }
    return null;
  }

  /** Find the card ID for a given requestId. */
  findCardByRequestId(requestId: string): CardId | undefined {
    for (const [, card] of this.cards) {
      if (card.pendingInput?.requestId === requestId) return card.id;
    }
    return undefined;
  }

  /** Check if a tool card already exists for the given tool_use_id. */
  hasToolCard(toolUseId: string): boolean {
    return this.toolUseIdToCardId.has(toolUseId);
  }

  /** Return all live cards (insertion order). Cards carry pendingInput if set. */
  getCards(): Card[] {
    return Array.from(this.cards.values());
  }

  toolResult(toolUseId: string, content: string, isError: boolean): CardEvent | null {
    const cardId = this.toolUseIdToCardId.get(toolUseId);
    if (!cardId) return null;
    const truncated = content.length > TOOL_RESULT_TRUNCATE_LENGTH;
    const resultContent = truncated
      ? content.slice(0, TOOL_RESULT_TRUNCATE_LENGTH) + ' [truncated]'
      : content;
    return this.updateEvent(cardId, {
      result: { content: resultContent, isError, truncated },
    });
  }

  subagentStart(description: string, agentId: string, toolUseId?: string): CardEvent {
    this.currentTextCardId = null;
    const id = this.nextId();
    const card: SubagentCard = {
      type: 'subagent', id, timestamp: Date.now(),
      description,
      toolUseId: toolUseId ?? agentId,
      agentId,
      status: 'running',
      toolUseCount: 0,
    };
    this.agentIdToCardId.set(agentId, id);
    // Position after the parent ToolCallCard if we have the toolUseId
    const afterCardId = toolUseId ? this.toolUseIdToCardId.get(toolUseId) : undefined;
    return this.addEvent(card, afterCardId);
  }

  subagentProgress(agentId: string, toolUseId: string | undefined, toolUseCount?: number, lastToolName?: string): CardEvent | null {
    const cardId = this.agentIdToCardId.get(agentId)
      ?? (toolUseId ? this.agentIdToCardId.get(toolUseId) : undefined);
    if (!cardId) return null;
    const patch: Record<string, unknown> = {};
    if (toolUseCount !== undefined) patch.toolUseCount = toolUseCount;
    if (lastToolName !== undefined) patch.lastToolName = lastToolName;
    return this.updateEvent(cardId, patch);
  }

  subagentEnd(
    agentId: string,
    toolUseId: string | undefined,
    status: 'completed' | 'failed' | 'stopped',
    summary?: string,
  ): CardEvent | null {
    const cardId = this.agentIdToCardId.get(agentId)
      ?? (toolUseId ? this.agentIdToCardId.get(toolUseId) : undefined);
    if (!cardId) return null;
    return this.updateEvent(cardId, { status, summary });
  }

  systemMessage(text: string, subtype?: 'compacted' | 'cost' | 'error' | 'info' | 'warning'): CardEvent {
    const card: Card = { type: 'system', id: this.nextId(), timestamp: Date.now(), text, subtype };
    return this.addEvent(card);
  }

  errorMessage(text: string): CardEvent {
    return this.systemMessage(`Error: ${text}`, 'error');
  }
}

// ============================================================================
// buildCardsFromHistory — convert JSONL history into Card[]
// ============================================================================

export async function buildCardsFromHistory(
  sessionId: string,
  cwd: string,
  offset = 0,
  limit = 50,
): Promise<CardHistoryResponse> {
  const allMessages = (await readMessagesFromJSONL(sessionId, cwd))
    .filter((m: any) => !m.isSidechain);

  const total = allMessages.length;
  const tailStart = Math.max(0, total - offset - limit);
  const tailEnd = Math.max(0, total - offset);
  const sliced = allMessages.slice(tailStart, tailEnd);

  // ── Pass 1: Build indexes from ALL messages ────────────────────────────

  // toolUseId → toolName (for tool_result lookup across pages)
  const agentToolUseIds = new Set<string>();
  // toolUseId → tool_result data (for pairing)
  const toolResults = new Map<string, { content: string; isError: boolean }>();

  for (const msg of allMessages) {
    const rawMsg = (msg as any).message as any;
    if (!Array.isArray(rawMsg?.content)) continue;
    for (const block of rawMsg.content) {
      if (block.type === 'tool_use' && block.name === 'Agent' && block.id) {
        agentToolUseIds.add(block.id);
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        const text = extractToolResultText(block.content);
        toolResults.set(block.tool_use_id, { content: text, isError: !!block.is_error });
      }
    }
  }

  // ── Get real agentIds from SDK listSubagents ───────────────────────────
  // System messages (task_started) are NOT reliably present in the JSONL.
  // Instead, read subagent meta.json files and match by description to the
  // Agent tool_use input.description.

  // Build description → toolUseId map from Agent tool_use blocks
  const descToToolUseId = new Map<string, string>();
  for (const msg of allMessages) {
    const rawMsg = (msg as any).message as any;
    if (!Array.isArray(rawMsg?.content)) continue;
    for (const block of rawMsg.content) {
      if (block.type === 'tool_use' && block.name === 'Agent' && block.id) {
        const desc = (block.input as any)?.description ?? '';
        if (desc) descToToolUseId.set(desc, block.id);
      }
    }
  }

  const toolUseIdToAgentId = new Map<string, string>();
  try {
    const agentIds = await listSubagentIdsFromDisk(sessionId, cwd);
    const subagentsDir = join(claudeProjectDir(cwd), sessionId, 'subagents');

    for (const agentId of agentIds) {
      try {
        const meta = JSON.parse(await readFile(join(subagentsDir, `${agentId}.meta.json`), 'utf-8'));
        if (meta?.description && descToToolUseId.has(meta.description)) {
          toolUseIdToAgentId.set(descToToolUseId.get(meta.description)!, agentId);
        }
      } catch { /* skip this agent */ }
    }
    // Fallback for any unmatched Agent tool_use IDs
    for (const toolUseId of agentToolUseIds) {
      if (!toolUseIdToAgentId.has(toolUseId)) {
        toolUseIdToAgentId.set(toolUseId, toolUseId);
      }
    }
  } catch {
    // No subagents or SDK error — fallback: agentId = toolUseId
    for (const toolUseId of agentToolUseIds) {
      toolUseIdToAgentId.set(toolUseId, toolUseId);
    }
  }

  // ── Pass 2: Build Cards from sliced messages ───────────────────────────

  let seq = tailStart;
  const nextId = () => `${sessionId}:h:${++seq}`;
  const cards: Card[] = [];

  for (const msg of sliced) {
    // ── System messages ──
    if (msg.type === 'system') {
      const subtype = (msg as any).subtype;
      // Skip subagent lifecycle events (handled via subagentCards below)
      if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_notification') continue;
      // Skip init and status messages (not useful in history)
      if (subtype === 'init' || subtype === 'status' || subtype === 'session_state_changed') continue;

      if (subtype === 'compact_boundary') {
        cards.push({ type: 'system', id: nextId(), timestamp: Date.now(), text: 'Context compacted', subtype: 'compacted' });
      } else {
        // Unknown system subtype — show as info
        cards.push({ type: 'system', id: nextId(), timestamp: Date.now(), text: subtype ?? 'System event', subtype: 'info' });
      }
      continue;
    }

    const rawMessage = (msg as any).message as any;
    if (!rawMessage?.content) {
      // Empty message — skip
      continue;
    }

    // ── User messages ──
    if (msg.type === 'user') {
      if (typeof rawMessage.content === 'string') {
        cards.push({ type: 'user', id: nextId(), timestamp: Date.now(), text: rawMessage.content });
        continue;
      }
      if (Array.isArray(rawMessage.content)) {
        for (const block of rawMessage.content) {
          if (block.type === 'text') {
            cards.push({ type: 'user', id: nextId(), timestamp: Date.now(), text: block.text });
          }
          // tool_result blocks are paired into ToolCallCard.result (handled below)
          // Skip them here — they don't need separate cards
        }
        continue;
      }
      continue;
    }

    // ── Assistant messages ──
    if (msg.type === 'assistant') {
      const blocks = rawMessage.content;
      if (!Array.isArray(blocks)) continue;

      for (const block of blocks) {
        switch (block.type) {
          case 'text':
            if (block.text) {
              cards.push({ type: 'assistant_text', id: nextId(), timestamp: Date.now(), text: block.text });
            }
            break;

          case 'thinking':
            if (block.thinking) {
              cards.push({ type: 'thinking', id: nextId(), timestamp: Date.now(), text: block.thinking });
            }
            break;

          case 'redacted_thinking':
            cards.push({ type: 'thinking', id: nextId(), timestamp: Date.now(), text: '[Redacted thinking]' });
            break;

          case 'tool_use': {
            if (agentToolUseIds.has(block.id)) {
              // Agent tool_use → create a ToolCallCard as anchor, then SubagentCard
              const agentId = toolUseIdToAgentId.get(block.id) ?? block.id;
              const result = toolResults.get(block.id);
              const description = (block.input as any)?.description ?? '';
              const summary = result ? result.content.slice(0, 200) : undefined;

              // Insert SubagentCard
              const subagentCard: SubagentCard = {
                type: 'subagent',
                id: nextId(),
                timestamp: Date.now(),
                description,
                toolUseId: block.id,
                agentId,
                status: result ? 'completed' : 'running',
                summary,
                toolUseCount: 0,
              };
              cards.push(subagentCard);
            } else {
              // Normal tool call
              const toolInput = typeof block.input === 'object' && block.input !== null
                ? block.input
                : {};
              const result = toolResults.get(block.id);
              let pairedResult: ToolCallCard['result'] | undefined;
              if (result) {
                const truncated = result.content.length > TOOL_RESULT_TRUNCATE_LENGTH;
                pairedResult = {
                  content: truncated
                    ? result.content.slice(0, TOOL_RESULT_TRUNCATE_LENGTH) + ' [truncated]'
                    : result.content,
                  isError: result.isError,
                  truncated,
                };
              }
              cards.push({
                type: 'tool_call',
                id: nextId(),
                timestamp: Date.now(),
                toolName: block.name,
                toolInput,
                toolUseId: block.id,
                result: pairedResult,
              });
            }
            break;
          }

          // Server tool blocks — show as generic tool calls
          case 'server_tool_use':
          case 'mcp_tool_use': {
            const toolInput = typeof block.input === 'object' && block.input !== null
              ? block.input
              : {};
            cards.push({
              type: 'tool_call',
              id: nextId(),
              timestamp: Date.now(),
              toolName: block.name ?? block.type,
              toolInput,
              toolUseId: block.id ?? nextId(),
            });
            break;
          }

          // Server/MCP tool results — show as system info
          case 'web_search_tool_result':
          case 'web_fetch_tool_result':
          case 'mcp_tool_result':
          case 'code_execution_tool_result':
          case 'bash_code_execution_tool_result':
          case 'text_editor_code_execution_tool_result':
          case 'tool_search_tool_result': {
            const resultText = extractToolResultText(block.content ?? block.text ?? '');
            const parentToolUseId = block.tool_use_id;
            // Try to pair with a previously emitted tool_call card
            if (parentToolUseId) {
              const parentCard = cards.find(
                (c): c is ToolCallCard => c.type === 'tool_call' && (c as ToolCallCard).toolUseId === parentToolUseId
              );
              if (parentCard && !parentCard.result) {
                const truncated = resultText.length > TOOL_RESULT_TRUNCATE_LENGTH;
                parentCard.result = {
                  content: truncated ? resultText.slice(0, TOOL_RESULT_TRUNCATE_LENGTH) + ' [truncated]' : resultText,
                  isError: !!block.is_error,
                  truncated,
                };
                break;
              }
            }
            // Fallback: show as system info
            if (resultText) {
              cards.push({ type: 'system', id: nextId(), timestamp: Date.now(), text: `${block.type}: ${resultText.slice(0, 200)}`, subtype: 'info' });
            }
            break;
          }

          case 'container_upload':
            cards.push({ type: 'system', id: nextId(), timestamp: Date.now(), text: 'Container upload', subtype: 'info' });
            break;

          // Unknown block types — skip silently
          default:
            break;
        }
      }
    }
  }

  return {
    cards,
    total,
    hasMore: tailStart > 0,
  };
}
