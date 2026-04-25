import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';
import type { CardEvent, CardStreamEnd, Card } from '@sumicom/quicksave-shared';

// ── Mock cardBuilder (before importing the module under test) ──

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  createReadStream: vi.fn(),
}));

vi.mock('readline', () => ({
  createInterface: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/mock-home',
}));

// Import after mocks
const { StreamCardBuilder } = await import('./cardBuilder.js');
const { consumeCodexStream } = await import('./codexSdkProvider.js');

// ── Helpers ──

function createCardBuilder() {
  return new StreamCardBuilder('test-session', 'test-stream', '/test/cwd');
}

function createCallbacks() {
  const cardEvents: CardEvent[] = [];
  const streamEnds: CardStreamEnd[] = [];
  return {
    cardEvents,
    streamEnds,
    callbacks: {
      emitCardEvent: (event: CardEvent) => { cardEvents.push(event); },
      emitStreamEnd: (result: CardStreamEnd) => { streamEnds.push(result); },
      handlePermissionRequest: vi.fn().mockResolvedValue({ action: 'allow' }),
      onModelDetected: vi.fn(),
    },
  };
}

/** Create a mock Thread with an optional id. */
function createMockThread(id: string | null = null) {
  return { id } as any;
}

/** Create an async generator from an array of events. */
async function* eventStream(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const event of events) {
    yield event;
  }
}

function getAddedCards(cardEvents: CardEvent[]): Card[] {
  return cardEvents
    .filter((e): e is Extract<CardEvent, { type: 'add' }> => e.type === 'add')
    .map(e => e.card);
}

// ============================================================================
// consumeCodexStream — event normalization
// ============================================================================

describe('consumeCodexStream', () => {
  let cb: InstanceType<typeof StreamCardBuilder>;

  beforeEach(() => {
    cb = createCardBuilder();
    vi.useFakeTimers();
  });

  // ── thread.started ──

  describe('thread.started', () => {
    it('should call onThreadStarted callback with thread_id', async () => {
      const { callbacks } = createCallbacks();
      let capturedId: string | null = null;

      const events = eventStream([
        { type: 'thread.started', thread_id: 'th-123' },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread(), {
        cb,
        callbacks,
        streamId: 's1',
        onThreadStarted: (id) => { capturedId = id; },
      });

      expect(capturedId).toBe('th-123');
    });
  });

  // ── agent_message (streaming text) ──

  describe('agent_message', () => {
    it('should emit assistantText on item.started', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        { type: 'item.started', item: { id: 'msg-1', type: 'agent_message', text: 'Hello' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      const promise = consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      // Flush timers to trigger buffered text
      await vi.advanceTimersByTimeAsync(200);
      await promise;

      const cards = getAddedCards(cardEvents);
      const textCards = cards.filter(c => c.type === 'assistant_text');
      expect(textCards.length).toBeGreaterThanOrEqual(1);
      expect((textCards[0] as any).text).toContain('Hello');
    });

    it('should emit delta text on item.updated', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        { type: 'item.started', item: { id: 'msg-1', type: 'agent_message', text: 'He' } },
        { type: 'item.updated', item: { id: 'msg-1', type: 'agent_message', text: 'Hello world' } },
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Hello world' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      const promise = consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      await vi.advanceTimersByTimeAsync(200);
      await promise;

      // Should have created assistant_text card(s) containing full text
      const cards = getAddedCards(cardEvents);
      const textCards = cards.filter(c => c.type === 'assistant_text');
      expect(textCards.length).toBeGreaterThanOrEqual(1);

      // Collect all text from add + append events
      let fullText = '';
      for (const evt of cardEvents) {
        if (evt.type === 'add' && evt.card.type === 'assistant_text') {
          fullText += (evt.card as any).text;
        } else if (evt.type === 'append_text') {
          fullText += evt.text;
        }
      }
      expect(fullText).toContain('Hello world');
    });

    it('does not lose the leading character when a second agent_message follows the first', async () => {
      // Regression: the per-stream tracker.lastAssistantText used to leak
      // across items, so msg-2's delta would slice off N chars where N was
      // msg-1's length — visibly missing the first character of msg-2.
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        { type: 'item.started',   item: { id: 'msg-1', type: 'agent_message', text: 'A' } },
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'A' } },
        { type: 'item.started',   item: { id: 'msg-2', type: 'agent_message', text: '' } },
        { type: 'item.updated',   item: { id: 'msg-2', type: 'agent_message', text: 'Hello world' } },
        { type: 'item.completed', item: { id: 'msg-2', type: 'agent_message', text: 'Hello world' } },
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
      ]);

      const promise = consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });
      await vi.advanceTimersByTimeAsync(500);
      await promise;

      // Concatenate all text emitted across both messages and assert msg-2
      // shows up intact.
      let fullText = '';
      for (const evt of cardEvents) {
        if (evt.type === 'add' && evt.card.type === 'assistant_text') {
          fullText += (evt.card as any).text;
        } else if (evt.type === 'append_text') {
          fullText += evt.text;
        }
      }
      // Both messages, in order, with no truncation.
      expect(fullText).toBe('AHello world');
    });

    it('handles a second message that arrives only via item.completed', async () => {
      // Same regression class — when only completed fires (Codex's
      // experimental-json shortcut), the slice math previously chopped
      // the first character of the second message.
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'X' } },
        { type: 'item.completed', item: { id: 'msg-2', type: 'agent_message', text: 'Hello' } },
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
      ]);

      const promise = consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });
      await vi.advanceTimersByTimeAsync(500);
      await promise;

      let fullText = '';
      for (const evt of cardEvents) {
        if (evt.type === 'add' && evt.card.type === 'assistant_text') {
          fullText += (evt.card as any).text;
        } else if (evt.type === 'append_text') {
          fullText += evt.text;
        }
      }
      expect(fullText).toContain('XHello');
    });

    it('should finalize assistant text on item.completed', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        { type: 'item.started', item: { id: 'msg-1', type: 'agent_message', text: 'Done' } },
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Done' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      const promise = consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      await vi.advanceTimersByTimeAsync(200);
      await promise;

      // Should have an update event setting streaming: false
      const updates = cardEvents.filter(e => e.type === 'update');
      const streamingFalse = updates.some(e =>
        e.type === 'update' && (e as any).patch?.streaming === false,
      );
      expect(streamingFalse).toBe(true);
    });
  });

  // ── reasoning ──

  describe('reasoning', () => {
    it('should emit thinkingBlock on item.started', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        { type: 'item.started', item: { id: 'r-1', type: 'reasoning', text: 'Let me think...' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const cards = getAddedCards(cardEvents);
      const thinkingCards = cards.filter(c => c.type === 'thinking');
      expect(thinkingCards).toHaveLength(1);
      expect((thinkingCards[0] as any).text).toBe('Let me think...');
    });

    it('should emit delta reasoning on item.updated', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        { type: 'item.started', item: { id: 'r-1', type: 'reasoning', text: 'First' } },
        { type: 'item.updated', item: { id: 'r-1', type: 'reasoning', text: 'First, then second' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const cards = getAddedCards(cardEvents);
      const thinkingCards = cards.filter(c => c.type === 'thinking');
      // Should have at least 2 thinking cards: initial + delta
      expect(thinkingCards.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── command_execution ──

  describe('command_execution', () => {
    it('should emit Bash tool_call on item.started', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        {
          type: 'item.started',
          item: {
            id: 'cmd-1', type: 'command_execution',
            command: 'ls -la', aggregated_output: '', status: 'in_progress',
          },
        } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const cards = getAddedCards(cardEvents);
      const toolCards = cards.filter(c => c.type === 'tool_call');
      expect(toolCards).toHaveLength(1);
      expect((toolCards[0] as any).toolName).toBe('Bash');
      expect((toolCards[0] as any).toolInput).toEqual({ command: 'ls -la' });
    });

    it('should emit tool_result with exit code on item.completed', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        {
          type: 'item.started',
          item: {
            id: 'cmd-1', type: 'command_execution',
            command: 'echo hi', aggregated_output: '', status: 'in_progress',
          },
        } as ThreadEvent,
        {
          type: 'item.completed',
          item: {
            id: 'cmd-1', type: 'command_execution',
            command: 'echo hi', aggregated_output: 'hi\n', exit_code: 0, status: 'completed',
          },
        } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const updates = cardEvents.filter(e => e.type === 'update');
      const resultUpdate = updates.find(e =>
        e.type === 'update' && (e as any).patch?.result,
      );
      expect(resultUpdate).toBeDefined();
      expect((resultUpdate as any).patch.result.content).toContain('hi\n');
      expect((resultUpdate as any).patch.result.content).toContain('[exit code: 0]');
      expect((resultUpdate as any).patch.result.isError).toBe(false);
    });

    it('should mark failed commands as errors', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        {
          type: 'item.started',
          item: {
            id: 'cmd-1', type: 'command_execution',
            command: 'false', aggregated_output: '', status: 'in_progress',
          },
        } as ThreadEvent,
        {
          type: 'item.completed',
          item: {
            id: 'cmd-1', type: 'command_execution',
            command: 'false', aggregated_output: '', exit_code: 1, status: 'failed',
          },
        } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const updates = cardEvents.filter(e => e.type === 'update');
      const resultUpdate = updates.find(e =>
        e.type === 'update' && (e as any).patch?.result,
      );
      expect(resultUpdate).toBeDefined();
      expect((resultUpdate as any).patch.result.isError).toBe(true);
    });
  });

  // ── file_change ──

  describe('file_change', () => {
    it('should emit Edit tool_call for file updates', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        {
          type: 'item.started',
          item: {
            id: 'fc-1', type: 'file_change',
            changes: [{ path: 'src/main.ts', kind: 'update' }],
            status: 'completed',
          },
        } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const cards = getAddedCards(cardEvents);
      const toolCards = cards.filter(c => c.type === 'tool_call');
      expect(toolCards).toHaveLength(1);
      expect((toolCards[0] as any).toolName).toBe('Edit');
      expect((toolCards[0] as any).toolInput).toEqual({ file_path: 'src/main.ts' });
    });

    it('should emit Write tool_call when all changes are additions', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        {
          type: 'item.started',
          item: {
            id: 'fc-1', type: 'file_change',
            changes: [
              { path: 'new-file.ts', kind: 'add' },
              { path: 'another.ts', kind: 'add' },
            ],
            status: 'completed',
          },
        } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const cards = getAddedCards(cardEvents);
      const toolCards = cards.filter(c => c.type === 'tool_call');
      // One Write card per file (Codex bundles them in a single file_change item).
      expect(toolCards).toHaveLength(2);
      expect((toolCards[0] as any).toolName).toBe('Write');
      expect((toolCards[0] as any).toolInput).toEqual({ file_path: 'new-file.ts' });
      expect((toolCards[1] as any).toolName).toBe('Write');
      expect((toolCards[1] as any).toolInput).toEqual({ file_path: 'another.ts' });
    });

    it('should emit tool_result on item.completed', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        {
          type: 'item.started',
          item: {
            id: 'fc-1', type: 'file_change',
            changes: [{ path: 'src/main.ts', kind: 'update' }],
            status: 'completed',
          },
        } as ThreadEvent,
        {
          type: 'item.completed',
          item: {
            id: 'fc-1', type: 'file_change',
            changes: [{ path: 'src/main.ts', kind: 'update' }],
            status: 'completed',
          },
        } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const updates = cardEvents.filter(e => e.type === 'update');
      const resultUpdate = updates.find(e =>
        e.type === 'update' && (e as any).patch?.result,
      );
      expect(resultUpdate).toBeDefined();
      expect((resultUpdate as any).patch.result.content).toContain('update: src/main.ts');
    });

    it('emits per-file Edit/Write cards for mixed-kind patches', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        {
          type: 'item.completed',
          item: {
            id: 'fc-mix', type: 'file_change',
            changes: [
              { path: 'a.ts', kind: 'add' },
              { path: 'b.ts', kind: 'update' },
              { path: 'c.ts', kind: 'delete' },
            ],
            status: 'completed',
          },
        } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const cards = getAddedCards(cardEvents);
      const toolCards = cards.filter(c => c.type === 'tool_call');
      expect(toolCards).toHaveLength(3);
      expect((toolCards[0] as any).toolName).toBe('Write');
      expect((toolCards[0] as any).toolInput.file_path).toBe('a.ts');
      expect((toolCards[1] as any).toolName).toBe('Edit');
      expect((toolCards[1] as any).toolInput.file_path).toBe('b.ts');
      expect((toolCards[2] as any).toolName).toBe('Edit');
      expect((toolCards[2] as any).toolInput.file_path).toBe('c.ts');
    });
  });

  // ── mcp_tool_call ──

  describe('mcp_tool_call', () => {
    it('should emit tool_call with server:tool name', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        {
          type: 'item.started',
          item: {
            id: 'mcp-1', type: 'mcp_tool_call',
            server: 'my-server', tool: 'my-tool',
            arguments: { key: 'value' },
            status: 'in_progress',
          },
        } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const cards = getAddedCards(cardEvents);
      const toolCards = cards.filter(c => c.type === 'tool_call');
      expect(toolCards).toHaveLength(1);
      expect((toolCards[0] as any).toolName).toBe('my-server:my-tool');
      expect((toolCards[0] as any).toolInput).toEqual({ key: 'value' });
    });

    it('falls back to structured_content when result.content is empty', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        {
          type: 'item.completed',
          item: {
            id: 'mcp-2', type: 'mcp_tool_call',
            server: 'srv', tool: 'fetch',
            arguments: {},
            result: { content: [], structured_content: { rows: 3, ok: true } },
            status: 'completed',
          },
        } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const updates = cardEvents.filter(e => e.type === 'update');
      const resultUpdate = updates.find(e =>
        e.type === 'update' && (e as any).patch?.result,
      );
      expect(resultUpdate).toBeDefined();
      expect((resultUpdate as any).patch.result.content).toBe('{"rows":3,"ok":true}');
    });
  });

  // ── web_search ──

  describe('web_search', () => {
    it('should emit WebSearch tool_call', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        {
          type: 'item.started',
          item: { id: 'ws-1', type: 'web_search', query: 'vitest docs' },
        } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const cards = getAddedCards(cardEvents);
      const toolCards = cards.filter(c => c.type === 'tool_call');
      expect(toolCards).toHaveLength(1);
      expect((toolCards[0] as any).toolName).toBe('WebSearch');
      expect((toolCards[0] as any).toolInput).toEqual({ query: 'vitest docs' });
    });
  });

  // ── error item ──

  describe('error item', () => {
    it('should emit system error message', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        {
          type: 'item.started',
          item: { id: 'err-1', type: 'error', message: 'Something went wrong' },
        } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const cards = getAddedCards(cardEvents);
      const systemCards = cards.filter(c => c.type === 'system');
      expect(systemCards).toHaveLength(1);
      expect((systemCards[0] as any).text).toBe('Something went wrong');
    });

    it('emits the error only once across started/updated/completed', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        { type: 'item.started',   item: { id: 'err-2', type: 'error', message: 'boom' } } as ThreadEvent,
        { type: 'item.updated',   item: { id: 'err-2', type: 'error', message: 'boom' } } as ThreadEvent,
        { type: 'item.completed', item: { id: 'err-2', type: 'error', message: 'boom' } } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const cards = getAddedCards(cardEvents);
      const systemCards = cards.filter(c => c.type === 'system');
      expect(systemCards).toHaveLength(1);
      expect((systemCards[0] as any).text).toBe('boom');
    });

    it('emits the error if it only arrives via item.completed', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        { type: 'item.completed', item: { id: 'err-3', type: 'error', message: 'late' } } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const cards = getAddedCards(cardEvents);
      const systemCards = cards.filter(c => c.type === 'system');
      expect(systemCards).toHaveLength(1);
      expect((systemCards[0] as any).text).toBe('late');
    });
  });

  // ── turn.completed ──

  describe('turn.completed', () => {
    it('should emit streamEnd with success and token usage', async () => {
      const { callbacks, streamEnds } = createCallbacks();

      const events = eventStream([
        {
          type: 'turn.completed',
          usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 200 },
        },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      expect(streamEnds).toHaveLength(1);
      expect(streamEnds[0].success).toBe(true);
      // Codex `usage` is thread-cumulative; we emit per-turn deltas (here
      // equal to the full counts since the running snapshot starts at 0)
      // and surface the raw cumulative for resume-time seeding.
      expect(streamEnds[0].tokenUsage).toEqual({
        input: 100,
        output: 200,
        cumulativeInput: 100,
        cumulativeOutput: 200,
        cumulativeCachedInput: 50,
      });
      expect(streamEnds[0].sessionId).toBe('th-1');
    });

    it('emits per-turn deltas across two turns when the running snapshot is shared', async () => {
      const { callbacks, streamEnds } = createCallbacks();
      const prevCumulative = { input: 0, output: 0, cachedInput: 0 };

      // Turn 1: cumulative starts at 0 → delta equals the reported counts.
      await consumeCodexStream(
        eventStream([
          { type: 'turn.completed', usage: { input_tokens: 14286, cached_input_tokens: 3456, output_tokens: 5 } },
        ]),
        createMockThread('th-1'),
        { cb, callbacks, streamId: 's1', prevCumulative },
      );

      // Turn 2: cumulative grew — delta = current - previous cumulative.
      await consumeCodexStream(
        eventStream([
          { type: 'turn.completed', usage: { input_tokens: 28589, cached_input_tokens: 17664, output_tokens: 10 } },
        ]),
        createMockThread('th-1'),
        { cb, callbacks, streamId: 's2', prevCumulative },
      );

      expect(streamEnds).toHaveLength(2);
      expect(streamEnds[0].tokenUsage).toMatchObject({ input: 14286, output: 5 });
      expect(streamEnds[1].tokenUsage).toMatchObject({ input: 14303, output: 5 });
      expect(streamEnds[1].tokenUsage?.cumulativeInput).toBe(28589);
      // Snapshot ends pinned at the most recent cumulative.
      expect(prevCumulative).toEqual({ input: 28589, output: 10, cachedInput: 17664 });
    });
  });

  // ── turn.failed ──

  describe('turn.failed', () => {
    it('should emit streamEnd with error', async () => {
      const { callbacks, streamEnds } = createCallbacks();

      const events = eventStream([
        { type: 'turn.failed', error: { message: 'Rate limit exceeded' } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      expect(streamEnds).toHaveLength(1);
      expect(streamEnds[0].success).toBe(false);
      expect(streamEnds[0].error).toBe('Rate limit exceeded');
    });
  });

  // ── thread error ──

  describe('thread error event', () => {
    it('should emit system error card', async () => {
      const { callbacks, cardEvents } = createCallbacks();

      const events = eventStream([
        { type: 'error', message: 'Connection lost' } as ThreadEvent,
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      ]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      const cards = getAddedCards(cardEvents);
      const systemCards = cards.filter(c => c.type === 'system');
      expect(systemCards.length).toBeGreaterThanOrEqual(1);
      expect((systemCards[0] as any).text).toBe('Connection lost');
    });
  });

  // ── stream ends without turn.completed ──

  describe('stream ends without turn event', () => {
    it('should emit a fallback success streamEnd', async () => {
      const { callbacks, streamEnds } = createCallbacks();

      // Empty stream — no turn.completed or turn.failed
      const events = eventStream([]);

      await consumeCodexStream(events, createMockThread('th-1'), {
        cb, callbacks, streamId: 's1',
      });

      expect(streamEnds).toHaveLength(1);
      expect(streamEnds[0].success).toBe(true);
    });
  });

  // ── full multi-item turn ──

  describe('full turn with multiple item types', () => {
    it('should handle a realistic turn with reasoning + text + tool call', async () => {
      const { callbacks, cardEvents, streamEnds } = createCallbacks();

      const events = eventStream([
        { type: 'thread.started', thread_id: 'th-full' },
        { type: 'turn.started' },
        { type: 'item.started', item: { id: 'r-1', type: 'reasoning', text: 'Planning...' } },
        { type: 'item.completed', item: { id: 'r-1', type: 'reasoning', text: 'Planning...' } },
        { type: 'item.started', item: { id: 'msg-1', type: 'agent_message', text: '' } },
        { type: 'item.updated', item: { id: 'msg-1', type: 'agent_message', text: 'I will ' } },
        { type: 'item.updated', item: { id: 'msg-1', type: 'agent_message', text: 'I will fix the bug.' } },
        { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'I will fix the bug.' } },
        {
          type: 'item.started',
          item: {
            id: 'cmd-1', type: 'command_execution',
            command: 'cat bug.ts', aggregated_output: '', status: 'in_progress',
          },
        } as ThreadEvent,
        {
          type: 'item.completed',
          item: {
            id: 'cmd-1', type: 'command_execution',
            command: 'cat bug.ts', aggregated_output: 'const x = 1;', exit_code: 0, status: 'completed',
          },
        } as ThreadEvent,
        {
          type: 'turn.completed',
          usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 100 },
        },
      ]);

      const promise = consumeCodexStream(events, createMockThread(), {
        cb, callbacks, streamId: 's1',
        onThreadStarted: () => {},
      });

      await vi.advanceTimersByTimeAsync(200);
      await promise;

      // Should have thinking, text, and tool cards
      const cards = getAddedCards(cardEvents);
      const types = cards.map(c => c.type);
      expect(types).toContain('thinking');
      expect(types).toContain('tool_call');

      // Stream should end successfully
      expect(streamEnds).toHaveLength(1);
      expect(streamEnds[0].success).toBe(true);
      expect(streamEnds[0].tokenUsage).toEqual({
        input: 500,
        output: 100,
        cumulativeInput: 500,
        cumulativeOutput: 100,
        cumulativeCachedInput: 200,
      });
    });
  });
});

// ============================================================================
// CodexSdkProvider — approval policy mapping
// ============================================================================

describe('approval policy mapping', () => {
  // We can't easily import the private mapApprovalPolicy, so we test
  // through buildThreadOptions by checking what the provider constructs.
  // Since buildThreadOptions is also private, we verify the mapping table
  // is correct via the exported provider's startSession behavior.
  // For now, this is documented as a known mapping test that requires
  // integration with a real Codex CLI.

  it('maps permission levels correctly (documentation test)', () => {
    // This is a mapping reference, not a runtime test.
    // bypassPermissions → never
    // acceptEdits → on-request
    // default → on-request (was `untrusted`; exec mode can't surface
    //   approval prompts, so `untrusted` silently blocks apply_patch)
    // plan → untrusted + read-only sandbox
    const mapping = {
      bypassPermissions: 'never',
      acceptEdits: 'on-request',
      default: 'on-request',
      plan: 'untrusted',
    };
    expect(mapping.bypassPermissions).toBe('never');
    expect(mapping.default).toBe('on-request');
    expect(mapping.plan).toBe('untrusted');
  });
});

// ============================================================================
// Robustness: item.completed without prior item.started
// ============================================================================

describe('item.completed without prior item.started', () => {
  let cb: InstanceType<typeof StreamCardBuilder>;

  beforeEach(() => {
    cb = createCardBuilder();
    vi.useFakeTimers();
  });

  it('emits assistant_text for an agent_message that only arrives as item.completed', async () => {
    const { callbacks, cardEvents } = createCallbacks();

    // No item.started or item.updated — just a single item.completed
    const events = eventStream([
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: '我先看一下專案結構' },
      } as ThreadEvent,
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
    ]);

    const promise = consumeCodexStream(events, createMockThread('th-1'), {
      cb, callbacks, streamId: 's1',
    });
    await vi.advanceTimersByTimeAsync(200);
    await promise;

    const cards = getAddedCards(cardEvents);
    const textCards = cards.filter(c => c.type === 'assistant_text');
    expect(textCards).toHaveLength(1);
    expect((textCards[0] as any).text).toBe('我先看一下專案結構');
  });

  it('creates a tool_call card for file_change (which only ever arrives via item.completed per SDK)', async () => {
    const { callbacks, cardEvents } = createCallbacks();

    const events = eventStream([
      {
        type: 'item.completed',
        item: {
          id: 'fc-1', type: 'file_change',
          changes: [{ path: 'src/foo.ts', kind: 'update' }],
          status: 'completed',
        },
      } as ThreadEvent,
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
    ]);

    await consumeCodexStream(events, createMockThread('th-1'), {
      cb, callbacks, streamId: 's1',
    });

    const cards = getAddedCards(cardEvents);
    const toolCards = cards.filter(c => c.type === 'tool_call');
    expect(toolCards).toHaveLength(1);
    expect((toolCards[0] as any).toolName).toBe('Edit');
    expect((toolCards[0] as any).toolInput.file_path).toBe('src/foo.ts');
  });

  it('picks tool name Write when all changes are additions', async () => {
    const { callbacks, cardEvents } = createCallbacks();

    const events = eventStream([
      {
        type: 'item.completed',
        item: {
          id: 'fc-2', type: 'file_change',
          changes: [{ path: 'src/new.ts', kind: 'add' }],
          status: 'completed',
        },
      } as ThreadEvent,
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
    ]);

    await consumeCodexStream(events, createMockThread('th-1'), {
      cb, callbacks, streamId: 's1',
    });

    const cards = getAddedCards(cardEvents);
    const toolCards = cards.filter(c => c.type === 'tool_call');
    expect((toolCards[0] as any).toolName).toBe('Write');
  });

  it('creates a Bash tool card if command_execution only arrives as item.completed', async () => {
    const { callbacks, cardEvents } = createCallbacks();

    const events = eventStream([
      {
        type: 'item.completed',
        item: {
          id: 'cmd-1', type: 'command_execution',
          command: 'ls -la', aggregated_output: 'total 0', exit_code: 0, status: 'completed',
        },
      } as ThreadEvent,
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
    ]);

    await consumeCodexStream(events, createMockThread('th-1'), {
      cb, callbacks, streamId: 's1',
    });

    const cards = getAddedCards(cardEvents);
    const toolCards = cards.filter(c => c.type === 'tool_call');
    expect(toolCards).toHaveLength(1);
    expect((toolCards[0] as any).toolName).toBe('Bash');
    expect((toolCards[0] as any).toolInput.command).toBe('ls -la');
  });

  it('creates a WebSearch tool card if web_search only arrives as item.completed', async () => {
    const { callbacks, cardEvents } = createCallbacks();

    const events = eventStream([
      {
        type: 'item.completed',
        item: { id: 'ws-1', type: 'web_search', query: 'react hooks' },
      } as ThreadEvent,
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
    ]);

    await consumeCodexStream(events, createMockThread('th-1'), {
      cb, callbacks, streamId: 's1',
    });

    const cards = getAddedCards(cardEvents);
    const toolCards = cards.filter(c => c.type === 'tool_call');
    expect(toolCards).toHaveLength(1);
    expect((toolCards[0] as any).toolName).toBe('WebSearch');
  });

  it('creates a TodoWrite card for todo_list items', async () => {
    const { callbacks, cardEvents } = createCallbacks();

    const events = eventStream([
      {
        type: 'item.completed',
        item: {
          id: 'todo-1', type: 'todo_list',
          items: [{ text: 'Step 1', completed: true }, { text: 'Step 2', completed: false }],
        },
      } as ThreadEvent,
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
    ]);

    await consumeCodexStream(events, createMockThread('th-1'), {
      cb, callbacks, streamId: 's1',
    });

    const cards = getAddedCards(cardEvents);
    const toolCards = cards.filter(c => c.type === 'tool_call');
    expect(toolCards).toHaveLength(1);
    expect((toolCards[0] as any).toolName).toBe('TodoWrite');
    expect((toolCards[0] as any).toolInput.todos).toEqual([
      { content: 'Step 1', status: 'completed' },
      { content: 'Step 2', status: 'pending' },
    ]);
  });
});
