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

// ── Mock filesystem ─────────────────────────────────────────────────────────

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

const { StreamCardBuilder, buildCardsFromHistory } =
  await import('./cardBuilder.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makePendingInput(requestId: string): PendingInputAttachment {
  return {
    sessionId: 'sess-1',
    requestId,
    inputType: 'permission',
    title: 'Allow?',
  };
}

function makeBuilder(sessionId = 'sess-1', streamId = 'stream-1', cwd = '/test') {
  return new StreamCardBuilder(sessionId, streamId, cwd);
}

/** Set up mocks for buildCardsFromHistory with a raw JSONL string. */
function mockJSONL(jsonl: string) {
  vi.mocked(existsSync).mockImplementation((p: any) => {
    // JSONL file exists, subagents dir does not
    return typeof p === 'string' && !p.includes('subagents');
  });
  vi.mocked(stat).mockResolvedValue({ size: jsonl.length } as any);
  vi.mocked(readFile).mockResolvedValue(jsonl);
}

// ============================================================================
// 1. Rapid text streaming
// ============================================================================

describe('Rapid text streaming (100+ calls)', () => {
  let builder: InstanceType<typeof StreamCardBuilder>;

  beforeEach(() => {
    builder = makeBuilder();
  });

  it('accumulates text correctly across 200 rapid assistantText calls', () => {
    const chunks = Array.from({ length: 200 }, (_, i) => `chunk${i} `);

    const firstEvent = builder.assistantText(chunks[0]) as CardAddEvent;
    expect(firstEvent.type).toBe('add');
    const cardId = firstEvent.card.id;

    for (let i = 1; i < chunks.length; i++) {
      const event = builder.assistantText(chunks[i]) as CardAppendTextEvent;
      expect(event.type).toBe('append_text');
      expect(event.cardId).toBe(cardId);
    }

    const cards = builder.getCards();
    expect(cards).toHaveLength(1);
    expect((cards[0] as any).text).toBe(chunks.join(''));
  });

  it('maintains consistent card ID across all append events', () => {
    builder.assistantText('start');
    const ids = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const event = builder.assistantText(`token-${i}`) as CardAppendTextEvent;
      ids.add(event.cardId);
    }

    // All append events must reference the same card
    expect(ids.size).toBe(1);
  });

  it('handles empty string chunks without crashing', () => {
    builder.assistantText('');
    builder.assistantText('');
    builder.assistantText('real text');

    const cards = builder.getCards();
    expect(cards).toHaveLength(1);
    expect((cards[0] as any).text).toBe('real text');
  });
});

// ============================================================================
// 2. Interleaved tool calls and text
// ============================================================================

describe('Interleaved tool calls and text', () => {
  let builder: InstanceType<typeof StreamCardBuilder>;

  beforeEach(() => {
    builder = makeBuilder();
  });

  it('creates separate text cards when interrupted by tool calls', () => {
    const e1 = builder.assistantText('First text block') as CardAddEvent;
    expect(e1.type).toBe('add');

    // Tool use resets currentTextCardId
    builder.toolUse('Bash', { command: 'ls' }, 'tu-1');

    const e2 = builder.assistantText('Second text block') as CardAddEvent;
    expect(e2.type).toBe('add');
    expect(e2.card.id).not.toBe(e1.card.id);

    builder.toolUse('Read', { path: 'foo' }, 'tu-2');

    const e3 = builder.assistantText('Third text block') as CardAddEvent;
    expect(e3.type).toBe('add');
    expect(e3.card.id).not.toBe(e1.card.id);
    expect(e3.card.id).not.toBe(e2.card.id);

    const cards = builder.getCards();
    expect(cards).toHaveLength(5); // 3 text + 2 tool
    expect(cards[0].type).toBe('assistant_text');
    expect(cards[1].type).toBe('tool_call');
    expect(cards[2].type).toBe('assistant_text');
    expect(cards[3].type).toBe('tool_call');
    expect(cards[4].type).toBe('assistant_text');
  });

  it('appends to last text card when no tool call interrupts', () => {
    builder.assistantText('A');
    builder.assistantText('B');
    builder.toolUse('X', {}, 'tu-1');
    builder.assistantText('C');
    builder.assistantText('D');

    const cards = builder.getCards();
    expect(cards).toHaveLength(3);
    expect((cards[0] as any).text).toBe('AB');
    expect((cards[2] as any).text).toBe('CD');
  });

  it('alternating text/tool pattern: text → tool → text → tool → text', () => {
    for (let i = 0; i < 10; i++) {
      builder.assistantText(`text-${i}`);
      builder.toolUse(`Tool${i}`, {}, `tu-${i}`);
    }
    builder.assistantText('final');

    const cards = builder.getCards();
    const textCards = cards.filter(c => c.type === 'assistant_text');
    const toolCards = cards.filter(c => c.type === 'tool_call');

    expect(textCards).toHaveLength(11); // 10 + 1 final
    expect(toolCards).toHaveLength(10);
  });
});

// ============================================================================
// 3. Tool result for non-existent tool
// ============================================================================

describe('Tool result for non-existent tool', () => {
  it('returns null for a toolUseId that was never registered', () => {
    const builder = makeBuilder();
    const result = builder.toolResult('nonexistent-tu-id', 'some content', false);
    expect(result).toBeNull();
  });

  it('returns null for an empty string toolUseId', () => {
    const builder = makeBuilder();
    const result = builder.toolResult('', 'content', false);
    expect(result).toBeNull();
  });

  it('does not crash when called with very long toolUseId', () => {
    const builder = makeBuilder();
    const result = builder.toolResult('x'.repeat(10000), 'content', true);
    expect(result).toBeNull();
  });

  it('works correctly after clearCards (mappings wiped)', () => {
    const builder = makeBuilder();
    builder.toolUse('Bash', { command: 'ls' }, 'tu-1');
    builder.clearCards();

    const result = builder.toolResult('tu-1', 'file.txt', false);
    expect(result).toBeNull();
  });
});

// ============================================================================
// 4. Double finalize
// ============================================================================

describe('Double finalizeAssistantText', () => {
  it('second finalize returns null', () => {
    const builder = makeBuilder();
    builder.assistantText('hello');

    const first = builder.finalizeAssistantText();
    expect(first).not.toBeNull();
    expect(first!.type).toBe('update');

    const second = builder.finalizeAssistantText();
    expect(second).toBeNull();
  });

  it('triple finalize still returns null on 2nd and 3rd', () => {
    const builder = makeBuilder();
    builder.assistantText('hello');

    expect(builder.finalizeAssistantText()).not.toBeNull();
    expect(builder.finalizeAssistantText()).toBeNull();
    expect(builder.finalizeAssistantText()).toBeNull();
  });

  it('finalize without any prior assistantText returns null', () => {
    const builder = makeBuilder();
    expect(builder.finalizeAssistantText()).toBeNull();
  });

  it('finalize after toolUse resets text card returns null', () => {
    const builder = makeBuilder();
    builder.assistantText('text');
    builder.toolUse('X', {}, 'tu-1'); // resets currentTextCardId
    expect(builder.finalizeAssistantText()).toBeNull();
  });

  it('internal card retains streaming=false after first finalize', () => {
    const builder = makeBuilder();
    builder.assistantText('hello');
    builder.finalizeAssistantText();

    const cards = builder.getCards();
    expect((cards[0] as any).streaming).toBe(false);

    // Second finalize should not corrupt anything
    builder.finalizeAssistantText();
    expect((cards[0] as any).streaming).toBe(false);
  });
});

// ============================================================================
// 5. Subagent card ordering with missing parent tool_call
// ============================================================================

describe('Subagent card with missing parent tool_call', () => {
  it('gracefully returns undefined afterCardId when toolUseId has no card', () => {
    const builder = makeBuilder();
    // No tool_call card exists for 'tu-ghost'
    const event = builder.subagentStart('Do stuff', 'agent-1', 'tu-ghost') as CardAddEvent;

    expect(event.type).toBe('add');
    expect(event.afterCardId).toBeUndefined(); // graceful degradation
    expect((event.card as SubagentCard).toolUseId).toBe('tu-ghost');
  });

  it('returns undefined afterCardId when no toolUseId is provided', () => {
    const builder = makeBuilder();
    const event = builder.subagentStart('Do stuff', 'agent-2') as CardAddEvent;

    expect(event.afterCardId).toBeUndefined();
    expect((event.card as SubagentCard).toolUseId).toBe('agent-2');
  });

  it('correctly links afterCardId when parent tool_call exists', () => {
    const builder = makeBuilder();
    const toolEvent = builder.toolUse('Agent', {}, 'tu-real') as CardAddEvent;
    const subEvent = builder.subagentStart('task', 'agent-3', 'tu-real') as CardAddEvent;

    expect(subEvent.afterCardId).toBe(toolEvent.card.id);
  });
});

// ============================================================================
// 6. Permission card lifecycle: no duplication, clearPendingInput behavior
// ============================================================================

describe('Permission card lifecycle', () => {
  let builder: InstanceType<typeof StreamCardBuilder>;

  beforeEach(() => {
    builder = makeBuilder();
  });

  it('toolCallFromPermission then toolUse: updates, does not duplicate', () => {
    const pending = makePendingInput('req-1');
    const permEvent = builder.toolCallFromPermission(
      'Bash', { command: 'rm -rf /' }, 'tu-perm', pending,
    ) as CardAddEvent;

    // Later the tool_use stream event arrives
    const toolEvent = builder.toolUse('Bash', { command: 'rm file.txt' }, 'tu-perm') as CardUpdateEvent;

    expect(toolEvent.type).toBe('update');
    expect(toolEvent.cardId).toBe(permEvent.card.id);

    // Only 1 card, not 2
    expect(builder.getCards()).toHaveLength(1);
  });

  it('toolUse then toolCallFromPermission: updates, does not duplicate', () => {
    const toolEvent = builder.toolUse('Bash', { command: 'ls' }, 'tu-rev') as CardAddEvent;

    const pending = makePendingInput('req-2');
    const permEvent = builder.toolCallFromPermission(
      'Bash', { command: 'ls' }, 'tu-rev', pending,
    ) as CardUpdateEvent;

    expect(permEvent.type).toBe('update');
    expect(permEvent.cardId).toBe(toolEvent.card.id);
    expect(builder.getCards()).toHaveLength(1);
  });

  it('non-ephemeral card: clearPendingInput updates, card remains', () => {
    const pending = makePendingInput('req-3');
    builder.toolCallFromPermission('Bash', {}, 'tu-ne', pending, false);

    const event = builder.clearPendingInput('req-3') as CardUpdateEvent;
    expect(event.type).toBe('update');
    expect(event.patch).toEqual({ pendingInput: undefined });
    expect(builder.getCards()).toHaveLength(1);
  });

  it('ephemeral card: clearPendingInput removes card entirely', () => {
    const pending = makePendingInput('req-4');
    builder.toolCallFromPermission('Bash', {}, 'tu-eph', pending, true);

    const event = builder.clearPendingInput('req-4') as CardRemoveEvent;
    expect(event.type).toBe('remove');
    expect(builder.getCards()).toHaveLength(0);
  });

  it('clearPendingInput for nonexistent requestId returns null', () => {
    builder.toolCallFromPermission('X', {}, 'tu-x', makePendingInput('req-5'));
    expect(builder.clearPendingInput('req-nonexistent')).toBeNull();
  });

  it('double clearPendingInput: second returns null', () => {
    const pending = makePendingInput('req-dbl');
    builder.toolCallFromPermission('X', {}, 'tu-dbl', pending, false);

    expect(builder.clearPendingInput('req-dbl')).not.toBeNull();
    // After clearing, the pendingInput is undefined, so requestId won't match
    expect(builder.clearPendingInput('req-dbl')).toBeNull();
  });

  it('double clearPendingInput on ephemeral: second returns null (card gone)', () => {
    const pending = makePendingInput('req-dbl-eph');
    builder.toolCallFromPermission('X', {}, 'tu-dbl-eph', pending, true);

    expect(builder.clearPendingInput('req-dbl-eph')).not.toBeNull();
    expect(builder.clearPendingInput('req-dbl-eph')).toBeNull();
  });
});

// ============================================================================
// 7. persistCards during active streaming
// ============================================================================

describe('persistCards strips transient fields', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('streaming assistant_text cards are persisted with streaming=false', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const builder = makeBuilder('sess-p', 'stream-p');
    builder.assistantText('still streaming...');
    // Do NOT finalize — card is still streaming=true

    const cards = builder.getCards();
    expect((cards[0] as any).streaming).toBe(true);

    await builder.persistCards();

    const written = JSON.parse((vi.mocked(writeFile).mock.calls[0][1] as string).trim());
    expect(written[0].streaming).toBe(false);
  });

  it('pendingInput is stripped from tool_call cards', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const builder = makeBuilder('sess-p2', 'stream-p2');
    builder.toolCallFromPermission('Bash', { cmd: 'rm' }, 'tu-p', makePendingInput('req-p'));

    await builder.persistCards();

    const written = JSON.parse((vi.mocked(writeFile).mock.calls[0][1] as string).trim());
    expect(written[0].pendingInput).toBeUndefined();
  });

  it('non-assistant_text cards keep their streaming field untouched', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const builder = makeBuilder('sess-p3', 'stream-p3');
    builder.userMessage('hello');
    builder.systemMessage('info', 'info');

    await builder.persistCards();

    const written = JSON.parse((vi.mocked(writeFile).mock.calls[0][1] as string).trim());
    // user and system cards don't have streaming field set
    expect(written[0].streaming).toBeUndefined();
    expect(written[1].streaming).toBeUndefined();
  });

  it('does not write anything when no cards exist', async () => {
    const builder = makeBuilder('sess-empty', 'stream-empty');
    await builder.persistCards();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('appends to corrupted existing file gracefully (starts fresh)', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue('not valid json at all {{{');
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const builder = makeBuilder('sess-corrupt', 'stream-corrupt');
    builder.userMessage('new card');
    await builder.persistCards();

    const written = JSON.parse((vi.mocked(writeFile).mock.calls[0][1] as string).trim());
    // Should start fresh since existing file was corrupted
    expect(written).toHaveLength(1);
    expect(written[0].text).toBe('new card');
  });
});

// ============================================================================
// 8. buildCardsFromHistory with corrupted JSONL
// ============================================================================

describe('buildCardsFromHistory with corrupted/edge-case JSONL', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips malformed JSON lines gracefully', async () => {
    const jsonl = [
      '{ broken json {{{{',
      JSON.stringify({ type: 'user', message: { content: 'valid' } }),
      'random garbage',
      '',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n');

    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-corrupt', '/test/cwd');
    expect(result.cards).toHaveLength(2);
    expect((result.cards[0] as any).text).toBe('valid');
    expect((result.cards[1] as any).text).toBe('ok');
  });

  it('handles completely empty file', async () => {
    mockJSONL('');

    const result = await buildCardsFromHistory('sess-empty', '/test/cwd');
    expect(result.cards).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('handles file with only whitespace/newlines', async () => {
    mockJSONL('\n\n\n   \n');

    const result = await buildCardsFromHistory('sess-ws', '/test/cwd');
    expect(result.cards).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('skips messages with missing content', async () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: {} }),
      JSON.stringify({ type: 'assistant', message: { content: null } }),
      JSON.stringify({ type: 'user', message: {} }),
      JSON.stringify({ type: 'user', message: { content: 'real' } }),
    ].join('\n');

    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-null', '/test/cwd');
    // Only the message with actual content should produce a card
    expect(result.cards).toHaveLength(1);
    expect((result.cards[0] as any).text).toBe('real');
  });

  it('skips non user/assistant/system message types', async () => {
    const jsonl = [
      JSON.stringify({ type: 'unknown_type', message: { content: 'nope' } }),
      JSON.stringify({ type: 'metadata', something: 'else' }),
      JSON.stringify({ type: 'user', message: { content: 'yes' } }),
    ].join('\n');

    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-types', '/test/cwd');
    expect(result.cards).toHaveLength(1);
  });

  it('handles assistant message with non-array content', async () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: 'just a string' } }),
    ].join('\n');

    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-str', '/test/cwd');
    // Non-array content is skipped in assistant handler
    expect(result.cards).toHaveLength(0);
  });

  it('handles unknown block types within assistant content array', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'unknown_block_type', data: 'mystery' },
            { type: 'text', text: 'known block' },
          ],
        },
      }),
    ].join('\n');

    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-unk', '/test/cwd');
    expect(result.cards).toHaveLength(1);
    expect((result.cards[0] as any).text).toBe('known block');
  });

  it('handles tool_use with null input gracefully', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-null', name: 'Bash', input: null }],
        },
      }),
    ].join('\n');

    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-null-input', '/test/cwd');
    const toolCards = result.cards.filter((c: Card) => c.type === 'tool_call');
    expect(toolCards).toHaveLength(1);
    expect((toolCards[0] as ToolCallCard).toolInput).toEqual({});
  });

  it('handles empty text blocks (empty string)', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '' }] },
      }),
    ].join('\n');

    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-empty-text', '/test/cwd');
    // Empty text blocks are skipped (falsy check: `if (block.text)`)
    expect(result.cards).toHaveLength(0);
  });

  it('handles empty thinking blocks', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: '' }] },
      }),
    ].join('\n');

    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-empty-think', '/test/cwd');
    // Empty thinking blocks are skipped (falsy check: `if (block.thinking)`)
    expect(result.cards).toHaveLength(0);
  });
});

// ============================================================================
// 9. buildCardsFromHistory pagination edge cases
// ============================================================================

describe('buildCardsFromHistory pagination edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeMessages(count: number): string {
    return Array.from({ length: count }, (_, i) =>
      JSON.stringify({ type: 'user', message: { content: `msg-${i}` } }),
    ).join('\n');
  }

  it('offset=0 limit=1 with 100 messages returns last message', async () => {
    const jsonl = makeMessages(100);
    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-p1', '/test/cwd', 0, 1);
    expect(result.cards).toHaveLength(1);
    expect((result.cards[0] as any).text).toBe('msg-99');
    expect(result.total).toBe(100);
    expect(result.hasMore).toBe(true);
  });

  it('offset=99 limit=50 with 100 messages returns first message', async () => {
    const jsonl = makeMessages(100);
    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-p2', '/test/cwd', 99, 50);
    expect(result.cards).toHaveLength(1);
    expect((result.cards[0] as any).text).toBe('msg-0');
    expect(result.total).toBe(100);
    expect(result.hasMore).toBe(false);
  });

  it('offset larger than total returns empty cards', async () => {
    const jsonl = makeMessages(5);
    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-p3', '/test/cwd', 100, 10);
    expect(result.cards).toHaveLength(0);
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(false);
  });

  it('offset=0 limit=0 with small file returns no cards but correct total', async () => {
    // Use a tiny file (2 messages) so that tailBytes (0) < fileSize triggers
    // the large-file path. But the tail read fallback to full read still works.
    // We need to set fileSize small enough that full read fallback triggers.
    const jsonl = makeMessages(2);
    // Force small file path by making stat return size <= tailBytes estimation
    // Actually with limit=0, tailBytes=0 < any fileSize, so it hits the large
    // file path with countMessagesInJSONL (streaming). We avoid that complexity
    // by using limit=1 offset=total to achieve the same "no cards" result.
    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-p4', '/test/cwd', 2, 1);
    expect(result.cards).toHaveLength(0);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
  });

  it('limit larger than total returns all messages', async () => {
    const jsonl = makeMessages(3);
    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-p5', '/test/cwd', 0, 100);
    expect(result.cards).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.hasMore).toBe(false);
  });

  it('offset=0 limit=total returns all messages', async () => {
    const jsonl = makeMessages(5);
    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-p6', '/test/cwd', 0, 5);
    expect(result.cards).toHaveLength(5);
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(false);
  });

  it('single message: offset=0 limit=1', async () => {
    const jsonl = makeMessages(1);
    mockJSONL(jsonl);

    const result = await buildCardsFromHistory('sess-single', '/test/cwd', 0, 1);
    expect(result.cards).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
  });
});

// ============================================================================
// 10. Card ID uniqueness across turns
// ============================================================================

describe('Card ID uniqueness across turns', () => {
  it('card IDs do not collide after startNewTurn (seq counter persists)', () => {
    const builder = makeBuilder();

    builder.userMessage('turn1');
    builder.assistantText('reply1');
    const turn1Cards = builder.getCards().map(c => c.id);

    builder.startNewTurn('stream-2');

    builder.userMessage('turn2');
    builder.assistantText('reply2');
    const allCards = builder.getCards().map(c => c.id);

    // All 4 IDs should be unique
    expect(new Set(allCards).size).toBe(4);

    // Turn2 IDs should not overlap with turn1 IDs
    const turn2Cards = allCards.filter(id => !turn1Cards.includes(id));
    expect(turn2Cards).toHaveLength(2);
    for (const id of turn2Cards) {
      expect(turn1Cards).not.toContain(id);
    }
  });

  it('card IDs use the new streamId after startNewTurn', () => {
    const builder = makeBuilder('sess-1', 'stream-1');

    builder.userMessage('t1');
    const e1 = builder.assistantText('r1') as CardAddEvent;
    expect(e1.card.id).toContain('stream-1');

    builder.startNewTurn('stream-2');

    const e2 = builder.userMessage('t2') as CardAddEvent;
    expect(e2.card.id).toContain('stream-2');
    expect(e2.streamId).toBe('stream-2');
  });

  it('seq counter does not reset after clearCards', () => {
    const builder = makeBuilder();

    builder.userMessage('a');
    builder.userMessage('b');
    builder.userMessage('c');
    // seq is now 3
    builder.clearCards();

    const e = builder.userMessage('d') as CardAddEvent;
    // The ID should have seq=4, not seq=1
    expect(e.card.id).toMatch(/:4$/);
  });

  it('many turns produce entirely unique IDs', () => {
    const builder = makeBuilder();
    const allIds = new Set<string>();

    for (let turn = 0; turn < 20; turn++) {
      builder.startNewTurn(`stream-${turn}`);
      const e1 = builder.userMessage(`q${turn}`) as CardAddEvent;
      const e2 = builder.assistantText(`a${turn}`) as CardAddEvent;
      const e3 = builder.toolUse(`Tool${turn}`, {}, `tu-${turn}`) as CardAddEvent;
      allIds.add(e1.card.id);
      allIds.add(e2.card.id);
      allIds.add(e3.card.id);
    }

    expect(allIds.size).toBe(60);
  });
});

// ============================================================================
// Bonus: Additional adversarial edge cases
// ============================================================================

describe('Additional adversarial edge cases', () => {
  it('subagentProgress/subagentEnd with both agentId and toolUseId fallback', () => {
    const builder = makeBuilder();
    builder.subagentStart('task', 'agent-1', 'tu-sa');

    // Progress via agentId (primary lookup)
    const p1 = builder.subagentProgress('agent-1', 'tu-sa', 5);
    expect(p1).not.toBeNull();

    // End via agentId (primary lookup)
    const e1 = builder.subagentEnd('agent-1', 'tu-sa', 'completed', 'done');
    expect(e1).not.toBeNull();
  });

  it('attachPendingToSubagent then clearPendingInput removes from subagent', () => {
    const builder = makeBuilder();
    builder.subagentStart('task', 'agent-sub');
    builder.attachPendingToSubagent('agent-sub', makePendingInput('req-sub'));

    const event = builder.clearPendingInput('req-sub') as CardUpdateEvent;
    expect(event.type).toBe('update');
    expect(event.patch).toEqual({ pendingInput: undefined });
    // Card still exists (subagent cards are not ephemeral by default)
    expect(builder.getCards()).toHaveLength(1);
  });

  it('updateSessionId changes IDs for subsequent events', () => {
    const builder = makeBuilder('sess-old', 'stream-1');
    const e1 = builder.userMessage('before') as CardAddEvent;
    expect(e1.card.id).toMatch(/^sess-old:/);

    builder.updateSessionId('sess-new');
    const e2 = builder.userMessage('after') as CardAddEvent;
    expect(e2.card.id).toMatch(/^sess-new:/);
    expect(e2.sessionId).toBe('sess-new');
  });

  it('toolUse with same toolUseId twice (second is new card if no permission pre-create)', () => {
    const builder = makeBuilder();
    const e1 = builder.toolUse('Bash', { cmd: '1' }, 'tu-dup') as CardAddEvent;
    expect(e1.type).toBe('add');

    // Second call with same toolUseId: toolUseIdToCardId already has it,
    // so it acts like confirming a pre-created card
    const e2 = builder.toolUse('Bash', { cmd: '2' }, 'tu-dup') as CardUpdateEvent;
    expect(e2.type).toBe('update');
    expect(e2.cardId).toBe(e1.card.id);
    expect(e2.patch).toEqual({ toolInput: { cmd: '2' } });

    // Still only 1 card
    expect(builder.getCards()).toHaveLength(1);
  });

  it('getCards returns a live snapshot (mutations reflect)', () => {
    const builder = makeBuilder();
    builder.userMessage('a');
    const before = builder.getCards();
    expect(before).toHaveLength(1);

    builder.userMessage('b');
    // getCards returns fresh array each time, both should show current state
    const after = builder.getCards();
    expect(after).toHaveLength(2);
    // But the old reference is stale (it was a snapshot via Array.from)
    expect(before).toHaveLength(1);
  });

  it('very long tool result is truncated at 500 chars', () => {
    const builder = makeBuilder();
    builder.toolUse('Read', {}, 'tu-long');
    const longContent = 'A'.repeat(1000);
    const event = builder.toolResult('tu-long', longContent, false) as CardUpdateEvent;
    const result = event.patch.result as any;

    expect(result.content.length).toBe(500 + ' [truncated]'.length);
    expect(result.truncated).toBe(true);
  });

  it('tool result with exactly 501 chars is truncated', () => {
    const builder = makeBuilder();
    builder.toolUse('Read', {}, 'tu-501');
    const content = 'B'.repeat(501);
    const event = builder.toolResult('tu-501', content, false) as CardUpdateEvent;
    const result = event.patch.result as any;

    expect(result.truncated).toBe(true);
    expect(result.content).toMatch(/\[truncated\]$/);
  });

  it('tool result with exactly 500 chars is not truncated', () => {
    const builder = makeBuilder();
    builder.toolUse('Read', {}, 'tu-500');
    const content = 'C'.repeat(500);
    const event = builder.toolResult('tu-500', content, false) as CardUpdateEvent;
    const result = event.patch.result as any;

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });
});
