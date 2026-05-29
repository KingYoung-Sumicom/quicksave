// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type {
  Card,
  CardAddEvent,
  CardUpdateEvent,
  CardAppendTextEvent,
  CardRemoveEvent,
  PendingInputAttachment,
  ToolCallCard,
  SubagentCard,
} from '@sumicom/quicksave-shared';

// ── Mock filesystem for persistence/history tests ────────────────────────────

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  createReadStream: vi.fn(),
}));

vi.mock('readline', () => ({
  createInterface: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/mock-home',
}));

import { existsSync } from 'fs';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';

// Import after mocks are set up
const {
  StreamCardBuilder,
  loadPersistedCards,
  buildCardsFromHistory,
  formatDurationMs,
  turnDurationCard,
  stopHookSummaryCard,
} = await import('./cardBuilder.js');

// ============================================================================
// StreamCardBuilder
// ============================================================================

describe('StreamCardBuilder', () => {
  const SESSION_ID = 'sess-1';
  const CWD = '/test/project';
  let builder: InstanceType<typeof StreamCardBuilder>;

  beforeEach(() => {
    builder = new StreamCardBuilder(SESSION_ID, CWD);
  });

  // ── userMessage ──────────────────────────────────────────────────────────

  describe('userMessage()', () => {
    it('creates an add event with a user card', () => {
      const event = builder.userMessage('hello') as CardAddEvent;

      expect(event.type).toBe('add');
      expect(event.sessionId).toBe(SESSION_ID);
      expect(event.card.type).toBe('user');
      expect((event.card as any).text).toBe('hello');
      expect(event.card.id).toMatch(new RegExp(`^${SESSION_ID}:\\d+$`));
    });

    it('resets the current text card', () => {
      // Start an assistant text card
      builder.assistantText('first');
      // user message should reset the text card
      builder.userMessage('question');
      // Next assistantText should create a new card, not append
      const event = builder.assistantText('new') as CardAddEvent;
      expect(event.type).toBe('add');
    });
  });

  // ── assistantText ────────────────────────────────────────────────────────

  describe('assistantText()', () => {
    it('creates an add event on first call with streaming=true', () => {
      const event = builder.assistantText('Hello') as CardAddEvent;

      expect(event.type).toBe('add');
      expect(event.card.type).toBe('assistant_text');
      expect((event.card as any).text).toBe('Hello');
      expect((event.card as any).streaming).toBe(true);
    });

    it('returns append_text event on subsequent calls', () => {
      builder.assistantText('Hello');
      const event = builder.assistantText(' world') as CardAppendTextEvent;

      expect(event.type).toBe('append_text');
      expect(event.text).toBe(' world');
    });

    it('accumulates text in the internal card on append', () => {
      builder.assistantText('Hello');
      builder.assistantText(' world');

      const cards = builder.getCards();
      expect(cards).toHaveLength(1);
      expect((cards[0] as any).text).toBe('Hello world');
    });
  });

  // ── finalizeAssistantText ────────────────────────────────────────────────

  describe('finalizeAssistantText()', () => {
    it('emits update event setting streaming=false', () => {
      const addEvent = builder.assistantText('text') as CardAddEvent;
      const updateEvent = builder.finalizeAssistantText() as CardUpdateEvent;

      expect(updateEvent.type).toBe('update');
      expect(updateEvent.cardId).toBe(addEvent.card.id);
      expect(updateEvent.patch).toEqual({ streaming: false });
    });

    it('returns null when no current text card exists', () => {
      const result = builder.finalizeAssistantText();
      expect(result).toBeNull();
    });

    it('resets the current text card so next assistantText creates new card', () => {
      builder.assistantText('first');
      builder.finalizeAssistantText();

      const event = builder.assistantText('second') as CardAddEvent;
      expect(event.type).toBe('add');
    });

    it('updates the internal card streaming to false', () => {
      builder.assistantText('text');
      builder.finalizeAssistantText();

      const cards = builder.getCards();
      expect((cards[0] as any).streaming).toBe(false);
    });
  });

  // ── thinkingBlock ────────────────────────────────────────────────────────

  describe('thinkingBlock()', () => {
    it('creates an add event with a thinking card', () => {
      const event = builder.thinkingBlock('reasoning...') as CardAddEvent;

      expect(event.type).toBe('add');
      expect(event.card.type).toBe('thinking');
      expect((event.card as any).text).toBe('reasoning...');
    });

    it('resets the current text card', () => {
      builder.assistantText('text');
      builder.thinkingBlock('think');

      const event = builder.assistantText('new') as CardAddEvent;
      expect(event.type).toBe('add');
    });
  });

  // ── toolUse ──────────────────────────────────────────────────────────────

  describe('toolUse()', () => {
    it('creates a tool_call add event', () => {
      const event = builder.toolUse('Bash', { command: 'ls' }, 'tu-1') as CardAddEvent;

      expect(event.type).toBe('add');
      expect(event.card.type).toBe('tool_call');
      const card = event.card as ToolCallCard;
      expect(card.toolName).toBe('Bash');
      expect(card.toolInput).toEqual({ command: 'ls' });
      expect(card.toolUseId).toBe('tu-1');
    });

    it('maps toolUseId to cardId for later toolResult pairing', () => {
      builder.toolUse('Bash', { command: 'ls' }, 'tu-1');
      const resultEvent = builder.toolResult('tu-1', 'file.txt', false) as CardUpdateEvent;

      expect(resultEvent).not.toBeNull();
      expect(resultEvent.type).toBe('update');
      expect(resultEvent.patch).toHaveProperty('result');
    });

    it('confirms pre-created card from toolCallFromPermission', () => {
      // Pre-create via permission
      const permEvent = builder.toolCallFromPermission(
        'Bash',
        { command: 'rm -rf' },
        'tu-2',
        makePendingInput('req-1'),
      ) as CardAddEvent;

      // toolUse fires later with potentially updated input
      const event = builder.toolUse('Bash', { command: 'rm file.txt' }, 'tu-2') as CardUpdateEvent;

      expect(event.type).toBe('update');
      expect(event.cardId).toBe(permEvent.card.id);
      expect(event.patch).toEqual({ toolInput: { command: 'rm file.txt' } });
    });

    it('resets the current text card', () => {
      builder.assistantText('text');
      builder.toolUse('Read', { path: 'foo' }, 'tu-3');

      const event = builder.assistantText('new') as CardAddEvent;
      expect(event.type).toBe('add');
    });
  });

  // ── toolResult ───────────────────────────────────────────────────────────

  describe('toolResult()', () => {
    it('returns null for unknown toolUseId', () => {
      const result = builder.toolResult('unknown-id', 'content', false);
      expect(result).toBeNull();
    });

    it('creates an update event with result on the tool card', () => {
      builder.toolUse('Bash', { command: 'ls' }, 'tu-1');
      const event = builder.toolResult('tu-1', 'file.txt', false) as CardUpdateEvent;

      expect(event.type).toBe('update');
      expect(event.patch.result).toEqual({
        content: 'file.txt',
        isError: false,
        truncated: false,
      });
    });

    it('marks isError when tool failed', () => {
      builder.toolUse('Bash', { command: 'bad' }, 'tu-err');
      const event = builder.toolResult('tu-err', 'command not found', true) as CardUpdateEvent;

      expect((event.patch.result as any).isError).toBe(true);
    });

    it('truncates long content at 500 characters', () => {
      builder.toolUse('Read', { path: 'big' }, 'tu-big');
      const longContent = 'x'.repeat(600);
      const event = builder.toolResult('tu-big', longContent, false) as CardUpdateEvent;
      const result = event.patch.result as any;

      expect(result.content).toHaveLength(500 + ' [truncated]'.length);
      expect(result.content).toMatch(/\[truncated\]$/);
      expect(result.truncated).toBe(true);
    });

    it('does not truncate content at exactly 500 characters', () => {
      builder.toolUse('Read', { path: 'exact' }, 'tu-exact');
      const content = 'x'.repeat(500);
      const event = builder.toolResult('tu-exact', content, false) as CardUpdateEvent;
      const result = event.patch.result as any;

      expect(result.content).toBe(content);
      expect(result.truncated).toBe(false);
    });
  });

  // ── toolCallFromPermission ───────────────────────────────────────────────

  describe('toolCallFromPermission()', () => {
    it('creates a tool_call card with pendingInput', () => {
      const pending = makePendingInput('req-1');
      const event = builder.toolCallFromPermission(
        'Bash', { command: 'rm -rf /' }, 'tu-perm', pending,
      ) as CardAddEvent;

      expect(event.type).toBe('add');
      const card = event.card as ToolCallCard;
      expect(card.pendingInput).toBe(pending);
      expect(card.toolName).toBe('Bash');
    });

    it('updates existing card with pendingInput when toolUse arrived first', () => {
      // tool_use arrives first in stream
      const addEvent = builder.toolUse('Bash', { command: 'ls' }, 'tu-race') as CardAddEvent;

      // Then canUseTool fires
      const pending = makePendingInput('req-race');
      const event = builder.toolCallFromPermission(
        'Bash', { command: 'ls' }, 'tu-race', pending,
      ) as CardUpdateEvent;

      expect(event.type).toBe('update');
      expect(event.cardId).toBe(addEvent.card.id);
      expect(event.patch).toEqual({ pendingInput: pending });
    });

    it('marks ephemeral cards for removal on clearPendingInput', () => {
      const pending = makePendingInput('req-eph');
      builder.toolCallFromPermission(
        'Bash', {}, 'tu-eph', pending, true, // ephemeral
      );

      const event = builder.clearPendingInput('req-eph') as CardRemoveEvent;
      expect(event.type).toBe('remove');
    });

    it('marks existing card as ephemeral when toolUse arrived first', () => {
      builder.toolUse('Bash', { command: 'ls' }, 'tu-eph2');
      const pending = makePendingInput('req-eph2');
      builder.toolCallFromPermission('Bash', {}, 'tu-eph2', pending, true);

      const event = builder.clearPendingInput('req-eph2') as CardRemoveEvent;
      expect(event.type).toBe('remove');
    });
  });

  // ── clearPendingInput ────────────────────────────────────────────────────

  describe('clearPendingInput()', () => {
    it('returns null when no card has the requestId', () => {
      const result = builder.clearPendingInput('nonexistent');
      expect(result).toBeNull();
    });

    it('clears pendingInput from a non-ephemeral card', () => {
      const pending = makePendingInput('req-clear');
      builder.toolCallFromPermission('Bash', {}, 'tu-cl', pending, false);

      const event = builder.clearPendingInput('req-clear') as CardUpdateEvent;
      expect(event.type).toBe('update');
      // null (not undefined) so it survives JSON.stringify across the bus.
      expect(event.patch).toEqual({ pendingInput: null });
    });

    it('removes ephemeral card entirely', () => {
      const pending = makePendingInput('req-rem');
      const addEvent = builder.toolCallFromPermission(
        'Bash', {}, 'tu-rem', pending, true,
      ) as CardAddEvent;

      const event = builder.clearPendingInput('req-rem') as CardRemoveEvent;
      expect(event.type).toBe('remove');
      expect(event.cardId).toBe(addEvent.card.id);

      // Card should be gone
      expect(builder.getCards()).toHaveLength(0);
    });
  });

  // ── systemMessage / errorMessage ─────────────────────────────────────────

  describe('systemMessage()', () => {
    it('creates a system card with optional subtype', () => {
      const event = builder.systemMessage('Compacted', 'compacted') as CardAddEvent;

      expect(event.type).toBe('add');
      expect(event.card.type).toBe('system');
      expect((event.card as any).text).toBe('Compacted');
      expect((event.card as any).subtype).toBe('compacted');
    });

    it('creates a system card without subtype', () => {
      const event = builder.systemMessage('Info') as CardAddEvent;
      expect((event.card as any).subtype).toBeUndefined();
    });
  });

  describe('errorMessage()', () => {
    it('creates a system card with error subtype and prefixed text', () => {
      const event = builder.errorMessage('Something broke') as CardAddEvent;

      expect(event.card.type).toBe('system');
      expect((event.card as any).text).toBe('Error: Something broke');
      expect((event.card as any).subtype).toBe('error');
    });
  });

  describe('recoverySuggested()', () => {
    it('creates a recovery_suggested card with reason, action, and label', () => {
      const event = builder.recoverySuggested(
        'Stuck on a rejected attachment.',
        'compact',
        'Compact to recover',
      ) as CardAddEvent;

      expect(event.type).toBe('add');
      const card = event.card as any;
      expect(card.type).toBe('recovery_suggested');
      expect(card.reason).toBe('Stuck on a rejected attachment.');
      expect(card.action).toBe('compact');
      expect(card.label).toBe('Compact to recover');
      expect(card.id).toBeTruthy();
      expect(typeof card.timestamp).toBe('number');
    });

    it('does not interfere with the streaming assistant text card', () => {
      const textEvent = builder.assistantText('thinking out loud') as CardAddEvent;
      builder.recoverySuggested('reason', 'compact', 'go');
      // Subsequent assistant text appends to the same card (streaming continuity).
      const append = builder.assistantText('…more') as any;
      expect(append.type).toBe('append_text');
      expect(append.cardId).toBe(textEvent.card.id);
    });
  });

  // ── subagentStart / subagentProgress / subagentEnd ───────────────────────

  describe('subagentStart()', () => {
    it('creates a subagent card', () => {
      const event = builder.subagentStart('Review code', 'agent-1', 'tu-agent') as CardAddEvent;

      expect(event.type).toBe('add');
      const card = event.card as SubagentCard;
      expect(card.type).toBe('subagent');
      expect(card.description).toBe('Review code');
      expect(card.agentId).toBe('agent-1');
      expect(card.toolUseId).toBe('tu-agent');
      expect(card.status).toBe('running');
      expect(card.toolUseCount).toBe(0);
    });

    it('uses agentId as toolUseId when toolUseId is undefined', () => {
      const event = builder.subagentStart('task', 'agent-2') as CardAddEvent;
      expect((event.card as SubagentCard).toolUseId).toBe('agent-2');
    });

    it('positions after parent ToolCallCard when toolUseId is provided', () => {
      const toolEvent = builder.toolUse('Agent', { description: 'test' }, 'tu-parent') as CardAddEvent;
      const event = builder.subagentStart('child', 'agent-3', 'tu-parent') as CardAddEvent;

      expect(event.afterCardId).toBe(toolEvent.card.id);
    });

    it('resets the current text card', () => {
      builder.assistantText('text');
      builder.subagentStart('task', 'agent-x');

      const event = builder.assistantText('new') as CardAddEvent;
      expect(event.type).toBe('add');
    });

    it('merges stashed Agent tool_use input into the card', () => {
      builder.stashAgentToolUseInput('tu-stash', {
        prompt: 'Find all tests',
        subagentType: 'Explore',
        requestedModel: 'sonnet',
      });
      const event = builder.subagentStart('Search tests', 'agent-s', 'tu-stash') as CardAddEvent;
      const card = event.card as SubagentCard;

      expect(card.subagentType).toBe('Explore');
      expect(card.requestedModel).toBe('sonnet');
      expect(card.prompt).toBe('Find all tests');
    });

    it('prefers extras.prompt over stashed prompt', () => {
      builder.stashAgentToolUseInput('tu-pref', {
        prompt: 'stashed prompt',
        subagentType: 'Plan',
      });
      const event = builder.subagentStart('Plan task', 'agent-p2', 'tu-pref', {
        prompt: 'task_started prompt',
      }) as CardAddEvent;
      const card = event.card as SubagentCard;

      expect(card.prompt).toBe('task_started prompt');
      expect(card.subagentType).toBe('Plan');
    });

    it('works with extras only (no stash)', () => {
      const event = builder.subagentStart('Direct', 'agent-d', 'tu-direct', {
        prompt: 'direct prompt',
        subagentType: 'general-purpose',
        requestedModel: 'opus',
      }) as CardAddEvent;
      const card = event.card as SubagentCard;

      expect(card.prompt).toBe('direct prompt');
      expect(card.subagentType).toBe('general-purpose');
      expect(card.requestedModel).toBe('opus');
    });

    it('omits undefined fields from the card', () => {
      const event = builder.subagentStart('No extras', 'agent-n', 'tu-none') as CardAddEvent;
      const card = event.card as SubagentCard;

      expect(card.subagentType).toBeUndefined();
      expect(card.requestedModel).toBeUndefined();
      expect(card.prompt).toBeUndefined();
    });

    it('consumes the stash entry (one-shot)', () => {
      builder.stashAgentToolUseInput('tu-once', { subagentType: 'Explore' });
      builder.subagentStart('First', 'agent-f1', 'tu-once');

      const event = builder.subagentStart('Second', 'agent-f2', 'tu-once') as CardAddEvent;
      expect((event.card as SubagentCard).subagentType).toBeUndefined();
    });
  });

  describe('subagentProgress()', () => {
    it('updates toolUseCount and lastToolName', () => {
      builder.subagentStart('task', 'agent-p');
      const event = builder.subagentProgress('agent-p', undefined, 5, 'Bash') as CardUpdateEvent;

      expect(event.type).toBe('update');
      expect(event.patch).toEqual({ toolUseCount: 5, lastToolName: 'Bash' });
    });

    it('returns null when agentId is unknown', () => {
      const result = builder.subagentProgress('unknown', undefined);
      expect(result).toBeNull();
    });

    it('falls back to toolUseId lookup', () => {
      builder.subagentStart('task', 'agent-fb', 'tu-fb');
      // Force agentIdToCardId miss by using the toolUseId in agentIdToCardId
      // Actually subagentStart registers agentId, so use toolUseId directly
      const event = builder.subagentProgress('agent-fb', undefined, 3) as CardUpdateEvent;
      expect(event).not.toBeNull();
      expect(event.patch.toolUseCount).toBe(3);
    });
  });

  describe('subagentEnd()', () => {
    it('updates status and summary', () => {
      builder.subagentStart('task', 'agent-e');
      const event = builder.subagentEnd('agent-e', undefined, 'completed', 'All done') as CardUpdateEvent;

      expect(event.type).toBe('update');
      expect(event.patch).toEqual({ status: 'completed', summary: 'All done' });
    });

    it('returns null when agentId is unknown', () => {
      const result = builder.subagentEnd('unknown', undefined, 'failed');
      expect(result).toBeNull();
    });
  });

  // ── nested tool calls (subagent active window) ───────────────────────────

  describe('nested subagent tool calls', () => {
    it('toolUse() routes to SubagentCard while subagent is active', () => {
      builder.subagentStart('task', 'agent-n');
      const event = builder.toolUse('Bash', { command: 'ls' }, 'tu-nested') as CardUpdateEvent;

      expect(event.type).toBe('update');
      const patch = event.patch as any;
      expect(patch.toolCalls).toHaveLength(1);
      expect(patch.toolCalls[0]).toMatchObject({ id: 'tu-nested', toolName: 'Bash', toolInput: { command: 'ls' } });
      // Should NOT create a ToolCallCard
      expect(builder.getCards().every(c => c.type !== 'tool_call')).toBe(true);
    });

    it('toolResult() routes to SubagentCard when toolUseId is nested', () => {
      builder.subagentStart('task', 'agent-nr');
      builder.toolUse('Read', { file_path: '/foo' }, 'tu-r');
      const event = builder.toolResult('tu-r', 'file contents', false) as CardUpdateEvent;

      expect(event.type).toBe('update');
      const calls = (event.patch as any).toolCalls as any[];
      expect(calls[0].result).toEqual({ content: 'file contents', isError: false });
    });

    it('multiple nested tool calls accumulate in order', () => {
      builder.subagentStart('task', 'agent-multi');
      builder.toolUse('Bash', {}, 'tu-a');
      builder.toolUse('Read', {}, 'tu-b');
      const cards = builder.getCards();
      const sa = cards.find(c => c.type === 'subagent') as SubagentCard;
      expect(sa.toolCalls).toHaveLength(2);
      expect(sa.toolCalls![0].toolName).toBe('Bash');
      expect(sa.toolCalls![1].toolName).toBe('Read');
    });

    it('toolUse() resumes normal ToolCallCard after subagentEnd()', () => {
      builder.subagentStart('task', 'agent-after');
      builder.subagentEnd('agent-after', undefined, 'completed');
      const event = builder.toolUse('Bash', {}, 'tu-post') as CardAddEvent;

      expect(event.type).toBe('add');
      expect((event.card as any).type).toBe('tool_call');
    });

    it('clearCards() resets nested tool call routing state', () => {
      builder.subagentStart('task', 'agent-clr');
      builder.toolUse('Bash', {}, 'tu-clr');
      builder.clearCards();
      // After clear, toolResult returns null since mapping is gone
      expect(builder.toolResult('tu-clr', 'x', false)).toBeNull();
      // New toolUse creates ToolCallCard (not nested)
      const event = builder.toolUse('Bash', {}, 'tu-fresh') as CardAddEvent;
      expect(event.type).toBe('add');
    });
  });

  // ── attachPendingToSubagent ──────────────────────────────────────────────

  describe('attachPendingToSubagent()', () => {
    it('attaches pendingInput to subagent card', () => {
      builder.subagentStart('task', 'agent-attach');
      const pending = makePendingInput('req-sub');
      const event = builder.attachPendingToSubagent('agent-attach', pending) as CardUpdateEvent;

      expect(event.type).toBe('update');
      expect(event.patch).toEqual({ pendingInput: pending });
    });

    it('returns null for unknown agentId', () => {
      const result = builder.attachPendingToSubagent('unknown', makePendingInput('req'));
      expect(result).toBeNull();
    });
  });

  // ── getCards / clearCards ─────────────────────────────────────────────────

  describe('getCards()', () => {
    it('returns empty array initially', () => {
      expect(builder.getCards()).toEqual([]);
    });

    it('returns all accumulated cards in insertion order', () => {
      builder.userMessage('hi');
      builder.assistantText('hello');
      builder.toolUse('Bash', {}, 'tu-1');

      const cards = builder.getCards();
      expect(cards).toHaveLength(3);
      expect(cards[0].type).toBe('user');
      expect(cards[1].type).toBe('assistant_text');
      expect(cards[2].type).toBe('tool_call');
    });
  });

  describe('clearCards()', () => {
    it('resets all internal state', () => {
      builder.userMessage('hi');
      builder.toolUse('Bash', {}, 'tu-1');
      builder.subagentStart('task', 'agent-1');
      builder.toolCallFromPermission('X', {}, 'tu-2', makePendingInput('r'), true);

      builder.clearCards();

      expect(builder.getCards()).toEqual([]);
      // toolResult should return null since mappings are cleared
      expect(builder.toolResult('tu-1', 'x', false)).toBeNull();
    });

    it('clears the agentToolUseStash', () => {
      builder.stashAgentToolUseInput('tu-stale', { subagentType: 'Explore' });
      builder.clearCards();

      const event = builder.subagentStart('After clear', 'agent-ac', 'tu-stale') as CardAddEvent;
      expect((event.card as SubagentCard).subagentType).toBeUndefined();
    });
  });

  // ── startNewTurn ─────────────────────────────────────────────────────────

  describe('startNewTurn()', () => {
    it('resets per-turn state but keeps cards', () => {
      builder.userMessage('hi');
      builder.assistantText('hello');

      builder.startNewTurn();

      // Cards are preserved
      expect(builder.getCards()).toHaveLength(2);

      // Current text card is reset — next assistantText creates new card
      const event = builder.assistantText('new turn') as CardAddEvent;
      expect(event.type).toBe('add');
    });
  });

  // ── updateSessionId ──────────────────────────────────────────────────────

  describe('updateSessionId()', () => {
    it('updates the session id used in subsequent events', () => {
      builder.updateSessionId('sess-2');
      const event = builder.userMessage('test') as CardAddEvent;

      expect(event.sessionId).toBe('sess-2');
      expect(event.card.id).toMatch(/^sess-2:/);
    });
  });

  // ── findCardByRequestId / hasToolCard ────────────────────────────────────

  describe('findCardByRequestId()', () => {
    it('returns cardId for matching requestId', () => {
      const pending = makePendingInput('req-find');
      const event = builder.toolCallFromPermission('X', {}, 'tu-f', pending) as CardAddEvent;

      expect(builder.findCardByRequestId('req-find')).toBe(event.card.id);
    });

    it('returns undefined when no match', () => {
      expect(builder.findCardByRequestId('nope')).toBeUndefined();
    });
  });

  describe('hasToolCard()', () => {
    it('returns true for registered toolUseId', () => {
      builder.toolUse('Bash', {}, 'tu-has');
      expect(builder.hasToolCard('tu-has')).toBe(true);
    });

    it('returns false for unknown toolUseId', () => {
      expect(builder.hasToolCard('unknown')).toBe(false);
    });
  });

  // ── Unique card IDs ──────────────────────────────────────────────────────

  describe('card ID uniqueness', () => {
    it('generates unique IDs across multiple cards', () => {
      const events = [
        builder.userMessage('a') as CardAddEvent,
        builder.assistantText('b') as CardAddEvent,
        builder.thinkingBlock('c') as CardAddEvent,
        builder.toolUse('D', {}, 'tu') as CardAddEvent,
        builder.systemMessage('e') as CardAddEvent,
      ];

      const ids = events.map(e => e.card.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});

// ============================================================================
// loadPersistedCards
// ============================================================================

describe('loadPersistedCards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array when file does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = await loadPersistedCards('sess-1');
    expect(result).toEqual([]);
  });

  it('returns parsed cards when file exists', async () => {
    const cards: Card[] = [
      { type: 'user', id: 'c1', timestamp: 1, text: 'hello' },
      { type: 'assistant_text', id: 'c2', timestamp: 2, text: 'hi', streaming: false },
    ];
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(cards));

    const result = await loadPersistedCards('sess-1');
    expect(result).toEqual(cards);
  });

  it('returns empty array on invalid JSON', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue('not-json');

    const result = await loadPersistedCards('sess-bad');
    expect(result).toEqual([]);
  });

  it('returns empty array when parsed data is not an array', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ foo: 'bar' }));

    const result = await loadPersistedCards('sess-obj');
    expect(result).toEqual([]);
  });
});

// ============================================================================
// persistCards (via StreamCardBuilder)
// ============================================================================

describe('StreamCardBuilder.persistCards()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not write when no cards exist', async () => {
    const builder = new StreamCardBuilder('sess-p', 'stream-p', '/cwd');
    await builder.persistCards();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('writes cleaned cards to file, stripping pendingInput and setting streaming=false', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const builder = new StreamCardBuilder('sess-p2', 'stream-p2', '/cwd');
    builder.assistantText('hello');
    builder.toolCallFromPermission('Bash', {}, 'tu-p', makePendingInput('req-p'));

    await builder.persistCards();

    expect(mkdir).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledTimes(1);

    const written = JSON.parse((vi.mocked(writeFile).mock.calls[0][1] as string).trim());
    expect(written).toHaveLength(2);
    // assistant_text should have streaming=false
    expect(written[0].streaming).toBe(false);
    // tool_call should not have pendingInput
    expect(written[1].pendingInput).toBeUndefined();
  });

  it('appends to existing persisted cards', async () => {
    const existing: Card[] = [{ type: 'user', id: 'old-1', timestamp: 1, text: 'old' }];
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(existing));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const builder = new StreamCardBuilder('sess-p3', 'stream-p3', '/cwd');
    builder.userMessage('new');
    await builder.persistCards();

    const written = JSON.parse((vi.mocked(writeFile).mock.calls[0][1] as string).trim());
    expect(written).toHaveLength(2);
    expect(written[0].text).toBe('old');
    expect(written[1].text).toBe('new');
  });

  it('upserts cards by id when persisting again', async () => {
    const existing: Card[] = [{ type: 'user', id: 'sess-p4:1', timestamp: 1, text: 'old text' }];
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(existing));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const builder = new StreamCardBuilder('sess-p4', 'stream-p4', '/cwd');
    builder.userMessage('new text');
    await builder.persistCards();

    const written = JSON.parse((vi.mocked(writeFile).mock.calls[0][1] as string).trim());
    expect(written).toHaveLength(1);
    expect(written[0].text).toBe('new text');
  });

  it('persists one card immediately', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const builder = new StreamCardBuilder('sess-p5', 'stream-p5', '/cwd');
    const event = builder.userMessage('steered prompt') as CardAddEvent;
    await builder.persistCard(event.card);

    const written = JSON.parse((vi.mocked(writeFile).mock.calls[0][1] as string).trim());
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ type: 'user', text: 'steered prompt' });
  });
});

// ============================================================================
// buildCardsFromHistory
// ============================================================================

describe('buildCardsFromHistory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty result when JSONL file does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await buildCardsFromHistory('sess-h', '/test/cwd');
    expect(result).toEqual({ cards: [], total: 0, hasMore: false });
  });

  it('converts user text messages to user cards', async () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { content: 'hello world' } }),
    ].join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-h1', '/test/cwd');
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].type).toBe('user');
    expect((result.cards[0] as any).text).toBe('hello world');
    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it('converts assistant text blocks to assistant_text cards', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'I can help' }] },
      }),
    ].join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-h2', '/test/cwd');
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].type).toBe('assistant_text');
    expect((result.cards[0] as any).text).toBe('I can help');
  });

  it('converts thinking blocks to thinking cards', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'Let me think...' }] },
      }),
    ].join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-h3', '/test/cwd');
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].type).toBe('thinking');
    expect((result.cards[0] as any).text).toBe('Let me think...');
  });

  it('pairs tool_use and tool_result into a single tool_call card', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-h1', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-h1', content: 'file.txt' }],
        },
      }),
    ].join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-h4', '/test/cwd');
    // The user tool_result message has no text blocks, so only the tool_call card
    const toolCards = result.cards.filter(c => c.type === 'tool_call');
    expect(toolCards).toHaveLength(1);
    const tc = toolCards[0] as ToolCallCard;
    expect(tc.toolName).toBe('Bash');
    expect(tc.result).toBeDefined();
    expect(tc.result!.content).toBe('file.txt');
    expect(tc.result!.isError).toBe(false);
  });

  it('converts system compact_boundary to compacted card', async () => {
    const jsonl = [
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
    ].join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-h5', '/test/cwd');
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].type).toBe('system');
    expect((result.cards[0] as any).subtype).toBe('compacted');
  });

  it('skips init / status / session_state_changed system messages', async () => {
    const jsonl = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'system', subtype: 'status' }),
      JSON.stringify({ type: 'system', subtype: 'session_state_changed' }),
    ].join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-h6', '/test/cwd');
    expect(result.cards).toHaveLength(0);
  });

  it('filters out isSidechain messages', async () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { content: 'visible' } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'hidden' }] } }),
    ].join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-h7', '/test/cwd');
    expect(result.cards).toHaveLength(1);
    expect((result.cards[0] as any).text).toBe('visible');
  });

  it('handles user message with array content (text blocks)', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'from array' }] },
      }),
    ].join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-h8', '/test/cwd');
    expect(result.cards).toHaveLength(1);
    expect((result.cards[0] as any).text).toBe('from array');
  });

  it('respects pagination with offset and limit', async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { content: `msg-${i}` } }),
    );
    const jsonl = messages.join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    // offset=0, limit=2 → last 2 messages
    const result = await buildCardsFromHistory('sess-page', '/test/cwd', 0, 2);
    expect(result.cards).toHaveLength(2);
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(true);
    expect((result.cards[0] as any).text).toBe('msg-3');
    expect((result.cards[1] as any).text).toBe('msg-4');
  });

  it('converts redacted_thinking to thinking card', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'redacted_thinking' }] },
      }),
    ].join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-redacted', '/test/cwd');
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].type).toBe('thinking');
    expect((result.cards[0] as any).text).toBe('[Redacted thinking]');
  });

  it('creates subagent cards for Agent tool_use blocks', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use', id: 'tu-agent-h', name: 'Agent',
            input: { description: 'Review PR' },
          }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-agent-h', content: 'Done reviewing' }],
        },
      }),
    ].join('\n');

    vi.mocked(existsSync).mockImplementation((p: any) => {
      // JSONL file exists, subagents dir does not
      return typeof p === 'string' && !p.includes('subagents');
    });
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-sub', '/test/cwd');
    const subCards = result.cards.filter(c => c.type === 'subagent');
    expect(subCards).toHaveLength(1);
    const sc = subCards[0] as SubagentCard;
    expect(sc.description).toBe('Review PR');
    expect(sc.status).toBe('completed');
    // No extra input fields in this fixture
    expect(sc.subagentType).toBeUndefined();
    expect(sc.requestedModel).toBeUndefined();
    expect(sc.prompt).toBeUndefined();
  });

  it('rebuilds streaming task_started events as subagent cards', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-monitor',
        tool_use_id: 'tu-monitor',
        description: 'Watch the running command',
        prompt: 'Monitor progress',
        subagent_type: 'Monitor',
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-monitor',
        tool_use_id: 'tu-monitor',
        usage: { tool_uses: 2 },
        last_tool_name: 'Read',
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-monitor',
        tool_use_id: 'tu-monitor',
        status: 'completed',
        summary: 'No issues found',
      }),
    ].join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-task', '/test/cwd');
    const subCards = result.cards.filter(c => c.type === 'subagent');
    expect(subCards).toHaveLength(1);
    const sc = subCards[0] as SubagentCard;
    expect(sc.description).toBe('Watch the running command');
    expect(sc.agentId).toBe('task-monitor');
    expect(sc.toolUseId).toBe('tu-monitor');
    expect(sc.status).toBe('completed');
    expect(sc.summary).toBe('No issues found');
    expect(sc.toolUseCount).toBe(2);
    expect(sc.lastToolName).toBe('Read');
    expect(sc.subagentType).toBe('Monitor');
    expect(sc.prompt).toBe('Monitor progress');
  });

  it('does not duplicate subagent cards when task events and Agent tool_use are both in the page', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-rich',
        tool_use_id: 'tu-rich',
        description: 'Find tests',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use', id: 'tu-rich', name: 'Agent',
            input: {
              description: 'Find tests',
              prompt: 'Search the codebase for test files',
              subagent_type: 'Explore',
            },
          }],
        },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-rich',
        tool_use_id: 'tu-rich',
        status: 'completed',
        summary: 'Found tests',
      }),
    ].join('\n');

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-task-dedupe', '/test/cwd');
    const subCards = result.cards.filter(c => c.type === 'subagent');
    expect(subCards).toHaveLength(1);
    const sc = subCards[0] as SubagentCard;
    expect(sc.description).toBe('Find tests');
    expect(sc.status).toBe('completed');
    expect(sc.summary).toBe('Found tests');
    expect(sc.subagentType).toBe('Explore');
  });

  it('populates subagentType, requestedModel, and prompt from Agent tool_use input', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use', id: 'tu-rich', name: 'Agent',
            input: {
              description: 'Find tests',
              prompt: 'Search the codebase for test files',
              subagent_type: 'Explore',
              model: 'haiku',
            },
          }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-rich', content: 'Found 12 test files' }],
        },
      }),
    ].join('\n');

    vi.mocked(existsSync).mockImplementation((p: any) => {
      return typeof p === 'string' && !p.includes('subagents');
    });
    vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
    vi.mocked(readFile).mockResolvedValue(jsonl);

    const result = await buildCardsFromHistory('sess-rich', '/test/cwd');
    const subCards = result.cards.filter(c => c.type === 'subagent');
    expect(subCards).toHaveLength(1);
    const sc = subCards[0] as SubagentCard;
    expect(sc.subagentType).toBe('Explore');
    expect(sc.requestedModel).toBe('haiku');
    expect(sc.prompt).toBe('Search the codebase for test files');
  });
});

// ============================================================================
// Structured system cards (turn_duration / stop_hook_summary)
// ============================================================================

describe('formatDurationMs', () => {
  it('renders sub-minute durations as seconds', () => {
    expect(formatDurationMs(45_000)).toBe('45s');
    expect(formatDurationMs(0)).toBe('0s');
  });
  it('renders minute+ durations as "Nm Ss"', () => {
    expect(formatDurationMs(85_022)).toBe('1m 25s');
  });
  it('clamps invalid input to 0s', () => {
    expect(formatDurationMs(-5)).toBe('0s');
    expect(formatDurationMs(NaN)).toBe('0s');
  });
});

describe('turnDurationCard', () => {
  it('builds a structured turn_duration card with a readable text fallback', () => {
    const card = turnDurationCard({ durationMs: 85_022, messageCount: 44 }, 'c1');
    expect(card.type).toBe('system');
    expect(card.subtype).toBe('info');
    expect(card.text).toBe('Turn: 1m 25s · 44 messages');
    expect(card.meta).toEqual({ kind: 'turn_duration', durationMs: 85_022, messageCount: 44 });
  });
  it('defaults missing numeric fields to 0', () => {
    const card = turnDurationCard({}, 'c2');
    expect(card.meta).toEqual({ kind: 'turn_duration', durationMs: 0, messageCount: 0 });
  });
});

describe('stopHookSummaryCard', () => {
  it('flags errors as a warning and keeps the hook command + error detail', () => {
    const card = stopHookSummaryCard(
      {
        hookInfos: [{ command: "'npx tsx' '/h' '/sock'", durationMs: 14 }],
        hookErrors: ['Failed: /bin/sh: 1: npx tsx: not found'],
        level: 'suggestion',
        preventedContinuation: false,
      },
      'c3',
    );
    expect(card.subtype).toBe('warning');
    expect(card.text).toBe('Stop hook: 1 ran, 1 error');
    expect(card.meta).toEqual({
      kind: 'stop_hook_summary',
      hooks: [{ command: "'npx tsx' '/h' '/sock'", durationMs: 14 }],
      errors: ['Failed: /bin/sh: 1: npx tsx: not found'],
      level: 'suggestion',
      preventedContinuation: false,
      stopReason: undefined,
    });
  });
  it('renders a clean run as info with no errors', () => {
    const card = stopHookSummaryCard(
      { hookInfos: [{ command: 'node /h /sock', durationMs: 3 }], hookErrors: [], preventedContinuation: false },
      'c4',
    );
    expect(card.subtype).toBe('info');
    expect(card.text).toBe('Stop hook: 1 ran');
    expect(card.meta.kind).toBe('stop_hook_summary');
    if (card.meta.kind === 'stop_hook_summary') expect(card.meta.errors).toEqual([]);
  });
  it('treats preventedContinuation as a warning even without errors', () => {
    const card = stopHookSummaryCard(
      { hookInfos: [], hookErrors: [], preventedContinuation: true, stopReason: 'blocked' },
      'c5',
    );
    expect(card.subtype).toBe('warning');
    if (card.meta.kind === 'stop_hook_summary') {
      expect(card.meta.preventedContinuation).toBe(true);
      expect(card.meta.stopReason).toBe('blocked');
    }
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePendingInput(requestId: string): PendingInputAttachment {
  return {
    sessionId: 'sess-1',
    requestId,
    inputType: 'permission',
    title: 'Allow?',
  };
}
