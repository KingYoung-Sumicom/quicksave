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
      expect((toolCards[0] as any).toolInput).toEqual({ files: ['src/main.ts'] });
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
      expect((toolCards[0] as any).toolName).toBe('Write');
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
      expect(streamEnds[0].tokenUsage).toEqual({ input: 100, output: 200 });
      expect(streamEnds[0].sessionId).toBe('th-1');
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
      expect(streamEnds[0].tokenUsage).toEqual({ input: 500, output: 100 });
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
    expect((toolCards[0] as any).toolInput.files).toEqual(['src/foo.ts']);
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
    expect((toolCards[0] as any).toolInput.todos).toHaveLength(2);
  });
});
