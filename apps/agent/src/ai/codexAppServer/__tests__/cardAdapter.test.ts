// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardEvent, CardStreamEnd } from '@sumicom/quicksave-shared';

import { StreamCardBuilder } from '../../cardBuilder.js';
import type { ProviderCallbacks } from '../../provider.js';

import { consumeAppServerStream } from '../cardAdapter.js';
import { CodexRpcClient, InMemoryTransport } from '../rpcClient.js';
import { TokenAccounting, makeBreakdown, makeUsage } from '../tokenAccounting.js';

/**
 * Test harness: spins a real StreamCardBuilder, a real CodexRpcClient
 * on top of a paired InMemoryTransport, and lets the test push v2
 * notifications from the "server" side while observing CardEvents
 * captured from a mock ProviderCallbacks.
 */
function harness(opts: { sessionId?: string; turnId?: string } = {}) {
  const sessionId = opts.sessionId ?? 'thr_test';
  const turnId = opts.turnId ?? 'turn_1';
  const cwd = '/tmp/quicksave-test';

  const cb = new StreamCardBuilder(sessionId, cwd);
  const events: CardEvent[] = [];
  let streamEnd: CardStreamEnd | null = null;

  const callbacks: ProviderCallbacks = {
    emitCardEvent: (e) => events.push(e),
    emitStreamEnd: (e) => {
      streamEnd = e;
    },
    handlePermissionRequest: vi.fn().mockResolvedValue({ action: 'allow' as const }),
    onModelDetected: vi.fn(),
  };

  const [clientSide, serverSide] = InMemoryTransport.pair();
  const rpc = new CodexRpcClient(clientSide);
  const tokens = new TokenAccounting();

  const consume = consumeAppServerStream(rpc, cb, { sessionId, threadId: sessionId, turnId, tokens }, callbacks);

  // The provider would normally emit the user message before turn/start.
  // We simulate that here so cards have a "starting point".
  callbacks.emitCardEvent(cb.userMessage('Run tests'));

  const send = async (method: string, params: unknown): Promise<void> => {
    await serverSide.send({ jsonrpc: '2.0', method, params } as unknown as { method: string; params: unknown });
    await flushMicrotasks();
  };

  return {
    sessionId,
    turnId,
    cb,
    rpc,
    tokens,
    events,
    get streamEnd(): CardStreamEnd | null {
      return streamEnd;
    },
    send,
    consume,
    serverSide,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function flushTextDebounce(): Promise<void> {
  // FLUSH_INTERVAL_MS = 150. Use real timers to keep tests close to
  // production behavior; vitest.fakeTimers() can be brittle with our
  // microtask + setTimeout interleaving.
  await new Promise((r) => setTimeout(r, 200));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('cardAdapter — agentMessage streaming', () => {
  it('chunked deltas append into a single assistant_text card and finalize on item/completed', async () => {
    const h = harness();
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'agentMessage', id: 'msg_1', text: '', phase: null, memoryCitation: null },
    });
    await h.send('item/agentMessage/delta', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      itemId: 'msg_1',
      delta: 'Hello ',
    });
    await h.send('item/agentMessage/delta', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      itemId: 'msg_1',
      delta: 'world',
    });
    await flushTextDebounce();
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'agentMessage', id: 'msg_1', text: 'Hello world', phase: null, memoryCitation: null },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });

    await h.consume;

    const text = h.events
      .filter((e) => e.type === 'add' && (e.card as { type?: string }).type === 'assistant_text')
      .map((e) => (e as { card: { text: string } }).card.text)
      .join('');
    const appended = h.events
      .filter((e) => e.type === 'append_text')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text + appended).toBe('Hello world');

    const finalize = h.events.find(
      (e) => e.type === 'update' && JSON.stringify(e.patch).includes('"streaming":false'),
    );
    expect(finalize).toBeTruthy();
  });

  it('emits the residual text on item/completed when started+deltas were missed', async () => {
    const h = harness();
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'agentMessage', id: 'msg_2', text: 'standalone reply', phase: null, memoryCitation: null },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const concatenated = h.events
      .filter((e) => e.type === 'add' && (e.card as { type?: string }).type === 'assistant_text')
      .map((e) => (e as { card: { text: string } }).card.text)
      .join('');
    expect(concatenated).toBe('standalone reply');
  });
});

describe('cardAdapter — commandExecution', () => {
  it('renders Bash tool_use on item/started and accumulates outputDelta chunks', async () => {
    const h = harness();
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'commandExecution',
        id: 'cmd_1',
        command: 'ls -la',
        cwd: '/tmp',
        processId: null,
        source: 'shell',
        status: 'running',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });
    await h.send('item/commandExecution/outputDelta', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      itemId: 'cmd_1',
      delta: 'line one\n',
    });
    await h.send('item/commandExecution/outputDelta', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      itemId: 'cmd_1',
      delta: 'line two\n',
    });
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'commandExecution',
        id: 'cmd_1',
        command: 'ls -la',
        cwd: '/tmp',
        processId: null,
        source: 'shell',
        status: 'completed',
        commandActions: [],
        aggregatedOutput: 'line one\nline two\n',
        exitCode: 0,
        durationMs: 1,
      },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;

    const toolCall = h.events.find(
      (e) => e.type === 'add' && (e.card as { type?: string }).type === 'tool_call',
    );
    expect(toolCall).toBeTruthy();
    expect((toolCall as { card: { toolName: string } }).card.toolName).toBe('Bash');

    const finalResult = [...h.events]
      .reverse()
      .find(
        (e) =>
          e.type === 'update' &&
          JSON.stringify(e.patch).includes('exit code: 0'),
      ) as { patch: { result: { content: string; isError: boolean } } } | undefined;
    expect(finalResult).toBeTruthy();
    expect(finalResult?.patch.result.content).toContain('line one');
    expect(finalResult?.patch.result.content).toContain('line two');
    expect(finalResult?.patch.result.content).toContain('exit code: 0');
    expect(finalResult?.patch.result.isError).toBe(false);
  });

  it('marks a failed command as isError', async () => {
    const h = harness();
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'commandExecution',
        id: 'cmd_2',
        command: 'false',
        cwd: '/tmp',
        processId: null,
        source: 'shell',
        status: 'running',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'commandExecution',
        id: 'cmd_2',
        command: 'false',
        cwd: '/tmp',
        processId: null,
        source: 'shell',
        status: 'failed',
        commandActions: [],
        aggregatedOutput: '',
        exitCode: 1,
        durationMs: 1,
      },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;

    const finalResult = [...h.events]
      .reverse()
      .find(
        (e) =>
          e.type === 'update' &&
          JSON.stringify(e.patch).includes('"isError":true'),
      );
    expect(finalResult).toBeTruthy();
  });
});

describe('cardAdapter — turn/plan/updated → TodoWrite card (R2)', () => {
  it('emits a TodoWrite tool_use with stable plan:turnId card id', async () => {
    const h = harness();
    await h.send('turn/plan/updated', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      explanation: null,
      plan: [
        { step: 'Read file', status: 'completed' },
        { step: 'Edit function', status: 'inProgress' },
        { step: 'Run tests', status: 'pending' },
      ],
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;

    const todoCard = h.events.find(
      (e) =>
        e.type === 'add' &&
        (e.card as { type?: string }).type === 'tool_call' &&
        (e.card as { toolName?: string }).toolName === 'TodoWrite',
    ) as { card: { toolUseId: string; toolInput: { todos: Array<{ content: string; status: string }> } } } | undefined;
    expect(todoCard).toBeTruthy();
    expect(todoCard?.card.toolUseId).toBe('plan:turn_1');
    expect(todoCard?.card.toolInput.todos).toEqual([
      { content: 'Read file', status: 'completed' },
      { content: 'Edit function', status: 'in_progress' },
      { content: 'Run tests', status: 'pending' },
    ]);
  });
});

describe('cardAdapter — error dedup (R3)', () => {
  it('emits an error system card once for `error` notification then `turn/completed { failed }`', async () => {
    const h = harness();
    await h.send('error', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      willRetry: false,
      error: { message: 'context window exceeded', codexErrorInfo: 'contextWindowExceeded', additionalDetails: null },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: {
        id: 'turn_1',
        items: [],
        status: 'failed',
        error: { message: 'context window exceeded', codexErrorInfo: 'contextWindowExceeded', additionalDetails: null },
        startedAt: 0,
        completedAt: 0,
        durationMs: 0,
      },
    });
    await h.consume;

    const errorCards = h.events.filter(
      (e) =>
        e.type === 'add' &&
        (e.card as { type?: string; subtype?: string }).type === 'system' &&
        (e.card as { subtype?: string }).subtype === 'error',
    );
    expect(errorCards).toHaveLength(1);

    expect(h.streamEnd?.success).toBe(false);
    expect(h.streamEnd?.error).toContain('context window exceeded');
  });

  it('suppresses error notifications with willRetry=true', async () => {
    const h = harness();
    await h.send('error', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      willRetry: true,
      error: { message: 'transient', codexErrorInfo: 'serverOverloaded', additionalDetails: null },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const errorCards = h.events.filter(
      (e) =>
        e.type === 'add' &&
        (e.card as { type?: string; subtype?: string }).type === 'system' &&
        (e.card as { subtype?: string }).subtype === 'error',
    );
    expect(errorCards).toHaveLength(0);
  });
});

describe('cardAdapter — token accounting via thread/tokenUsage/updated (R1)', () => {
  it('uses last/total directly from the v2 notification', async () => {
    const h = harness();
    await h.send('thread/tokenUsage/updated', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      tokenUsage: makeUsage(makeBreakdown(40, 20), makeBreakdown(40, 20, 5)),
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    expect(h.streamEnd?.tokenUsage).toEqual({
      input: 40,
      output: 20,
      cumulativeInput: 40,
      cumulativeOutput: 20,
      cumulativeCachedInput: 5,
    });
  });

  it('emits stream-end without tokenUsage when no notification arrives within grace window', async () => {
    const h = harness();
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    expect(h.streamEnd?.success).toBe(true);
    expect(h.streamEnd?.tokenUsage).toBeUndefined();
  });
});

describe('cardAdapter — turn/completed status mapping', () => {
  it('interrupted → CardStreamEnd { interrupted: true, success: false }', async () => {
    const h = harness();
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'interrupted', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    expect(h.streamEnd?.interrupted).toBe(true);
    expect(h.streamEnd?.success).toBe(false);
  });

  it('failed → success:false + error message + tokenUsage when available', async () => {
    const h = harness();
    await h.send('thread/tokenUsage/updated', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      tokenUsage: makeUsage(makeBreakdown(1, 0), makeBreakdown(1, 0)),
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: {
        id: 'turn_1',
        items: [],
        status: 'failed',
        error: { message: 'rate limited', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null },
        startedAt: 0,
        completedAt: 0,
        durationMs: 0,
      },
    });
    await h.consume;
    expect(h.streamEnd?.success).toBe(false);
    expect(h.streamEnd?.error).toContain('rate limited');
    expect(h.streamEnd?.tokenUsage).toEqual({
      input: 1,
      output: 0,
      cumulativeInput: 1,
      cumulativeOutput: 0,
      cumulativeCachedInput: 0,
    });
  });
});

describe('cardAdapter — serverRequest/resolved (R7)', () => {
  it('forwards to clearPendingInput and never emits stream-end', async () => {
    const h = harness();
    // Pre-create a tool_call with a pending input via toolCallFromPermission
    const evt = h.cb.toolCallFromPermission(
      'Bash',
      { command: 'ls' },
      'tool_pending_1',
      { kind: 'toolCall', requestId: 'req_42', toolName: 'Bash', toolInput: { command: 'ls' } },
    );
    h.events.push(evt);

    await h.send('serverRequest/resolved', { threadId: 'thr_test', requestId: 'req_42' });
    expect(h.streamEnd).toBeNull();

    // Now send turn/completed so consume() resolves.
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;

    const clearedUpdate = h.events.find(
      (e) =>
        e.type === 'update' && JSON.stringify(e.patch).includes('"pendingInput":null'),
    );
    expect(clearedUpdate).toBeTruthy();
  });
});

describe('cardAdapter — file_change', () => {
  it('emits a per-file Write/Edit tool_use card', async () => {
    const h = harness();
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'fileChange',
        id: 'fc_1',
        changes: [{ kind: 'add', path: '/tmp/new.txt' }],
        status: 'completed',
      },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;

    const writeCard = h.events.find(
      (e) =>
        e.type === 'add' &&
        (e.card as { type?: string }).type === 'tool_call' &&
        (e.card as { toolName?: string }).toolName === 'Write',
    );
    expect(writeCard).toBeTruthy();
  });

  it('parses unified diff into old_string/new_string for Edit cards', async () => {
    const h = harness();
    const diff = [
      '@@ -1,3 +1,3 @@',
      ' context line',
      '-old line one',
      '-old line two',
      '+new line one',
      '+new line two',
      ' trailing context',
    ].join('\n');
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'fileChange',
        id: 'fc_edit',
        changes: [{ kind: { type: 'update', move_path: null }, path: '/tmp/file.ts', diff }],
        status: 'completed',
      },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;

    const editCard = h.events.find(
      (e) =>
        e.type === 'add' &&
        (e.card as { type?: string }).type === 'tool_call' &&
        (e.card as { toolName?: string }).toolName === 'Edit',
    );
    expect(editCard).toBeTruthy();
    const input = (editCard as { card: { toolInput: Record<string, unknown> } }).card.toolInput;
    expect(input.file_path).toBe('/tmp/file.ts');
    expect(input.old_string).toBe('old line one\nold line two');
    expect(input.new_string).toBe('new line one\nnew line two');
  });

  it('parses unified diff into content for Write cards', async () => {
    const h = harness();
    const diff = [
      '@@ -0,0 +1,2 @@',
      '+first',
      '+second',
    ].join('\n');
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'fileChange',
        id: 'fc_write',
        changes: [{ kind: { type: 'add' }, path: '/tmp/new.txt', diff }],
        status: 'completed',
      },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;

    const writeCard = h.events.find(
      (e) =>
        e.type === 'add' &&
        (e.card as { type?: string }).type === 'tool_call' &&
        (e.card as { toolName?: string }).toolName === 'Write',
    );
    expect(writeCard).toBeTruthy();
    const input = (writeCard as { card: { toolInput: Record<string, unknown> } }).card.toolInput;
    expect(input.file_path).toBe('/tmp/new.txt');
    expect(input.content).toBe('first\nsecond');
  });

  it('handles object-shaped file change discriminators', async () => {
    const h = harness();
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'fileChange',
        id: 'fc_1',
        changes: [{ kind: { type: 'add' }, path: '/tmp/new.txt' }],
        status: 'in_progress',
      },
    });
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'fileChange',
        id: 'fc_1',
        changes: [{ type: { kind: 'modify' }, path: '/tmp/new.txt' }],
        status: 'completed',
      },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;

    const toolNames = h.events
      .filter((e) => e.type === 'add' && (e.card as { type?: string }).type === 'tool_call')
      .map((e) => (e.card as { toolName?: string }).toolName);
    expect(toolNames).toContain('Write');
    expect(h.streamEnd?.success).toBe(true);
  });
});

describe('cardAdapter — webSearch placeholder (R9 preserved)', () => {
  it('emits a synthetic Search: ${query} result on completed', async () => {
    const h = harness();
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'webSearch', id: 'ws_1', query: 'cats', action: null },
    });
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'webSearch', id: 'ws_1', query: 'cats', action: null },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const result = h.events.find(
      (e) =>
        e.type === 'update' &&
        JSON.stringify(e.patch).includes('Search: cats'),
    );
    expect(result).toBeTruthy();
  });

  // Regression: previously the toolUse card was created at item/started with
  // the empty `query` Codex sends there, and the item/completed handler
  // skipped the toolUse re-emit when the card already existed — so the PWA
  // saw "Search ?" forever. Both must update the toolInput.
  it('patches the empty-at-started toolInput when item/completed brings the real query', async () => {
    const h = harness();
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'webSearch', id: 'ws_2', query: '', action: { type: 'search', query: null, queries: null } },
    });
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'webSearch', id: 'ws_2', query: 'kittens', action: { type: 'search', query: 'kittens', queries: null } },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    // The card must end with toolInput.query = 'kittens'. Updates patch in
    // place; we look for the LAST update touching the toolInput field.
    const updates = h.events.filter(
      (e): e is Extract<typeof e, { type: 'update' }> =>
        e.type === 'update' && (e.patch as Record<string, unknown>).toolInput !== undefined,
    );
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const last = updates[updates.length - 1];
    expect((last.patch as { toolInput: { query: string } }).toolInput.query).toBe('kittens');
  });

  // When the model's webSearch routes through `action: { type: 'openPage' }`
  // or `findInPage`, the flat `item.query` stays empty even on completed.
  // Fall back to the structured action so the card still has SOMETHING.
  it('falls back to action.url when query stays empty (openPage variant)', async () => {
    const h = harness();
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'webSearch', id: 'ws_3', query: '', action: { type: 'openPage', url: 'https://example.com' } },
    });
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'webSearch', id: 'ws_3', query: '', action: { type: 'openPage', url: 'https://example.com' } },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const initialAdd = h.events.find(
      (e): e is Extract<typeof e, { type: 'add' }> =>
        e.type === 'add' && (e.card as { toolName?: string }).toolName === 'WebSearch',
    );
    expect((initialAdd?.card as { toolInput: { query: string } } | undefined)?.toolInput.query)
      .toBe('https://example.com');
  });

  it('falls back to joined queries[] when the search action has no flat query', async () => {
    const h = harness();
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'webSearch',
        id: 'ws_4',
        query: '',
        action: { type: 'search', query: null, queries: ['cats', 'kittens'] },
      },
    });
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'webSearch',
        id: 'ws_4',
        query: '',
        action: { type: 'search', query: null, queries: ['cats', 'kittens'] },
      },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const initialAdd = h.events.find(
      (e): e is Extract<typeof e, { type: 'add' }> =>
        e.type === 'add' && (e.card as { toolName?: string }).toolName === 'WebSearch',
    );
    expect((initialAdd?.card as { toolInput: { query: string } } | undefined)?.toolInput.query)
      .toBe('cats, kittens');
  });
});

describe('cardAdapter — reasoning summary delta', () => {
  it('emits thinking cards for non-empty reasoning deltas', async () => {
    const h = harness();
    await h.send('item/reasoning/summaryTextDelta', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      itemId: 'rsn_1',
      summaryIndex: 0,
      delta: 'Considering options',
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;

    const thinking = h.events.find(
      (e) => e.type === 'add' && (e.card as { type?: string }).type === 'thinking',
    );
    expect(thinking).toBeTruthy();
    expect((thinking as { card: { text: string } }).card.text).toBe('Considering options');
  });

  it('drops whitespace-only reasoning deltas', async () => {
    const h = harness();
    await h.send('item/reasoning/summaryTextDelta', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      itemId: 'rsn_2',
      summaryIndex: 0,
      delta: '   ',
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const thinking = h.events.find(
      (e) => e.type === 'add' && (e.card as { type?: string }).type === 'thinking',
    );
    expect(thinking).toBeFalsy();
  });

  it('item/completed reasoning falls back to content when summary is empty', async () => {
    const h = harness();
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'reasoning', id: 'rsn_3', summary: [], content: ['Step one', 'Step two'] },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const thinking = h.events.find(
      (e) => e.type === 'add' && (e.card as { type?: string }).type === 'thinking',
    );
    expect((thinking as { card: { text: string } } | undefined)?.card.text)
      .toBe('Step one\nStep two');
  });
});

describe('cardAdapter — surfaced control notifications', () => {
  it('guardianWarning emits a warning system card', async () => {
    const h = harness();
    await h.send('guardianWarning', { threadId: 'thr_test', message: 'risky operation flagged' });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const warn = h.events.find(
      (e): e is Extract<typeof e, { type: 'add' }> =>
        e.type === 'add' && (e.card as { subtype?: string }).subtype === 'warning',
    );
    expect((warn?.card as { text?: string } | undefined)?.text).toMatch(/risky operation flagged/);
  });

  it('guardianWarning for a different thread is ignored', async () => {
    const h = harness();
    await h.send('guardianWarning', { threadId: 'other_thread', message: 'not for us' });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const warn = h.events.find(
      (e): e is Extract<typeof e, { type: 'add' }> =>
        e.type === 'add' && (e.card as { subtype?: string }).subtype === 'warning',
    );
    expect(warn).toBeFalsy();
  });

  it('model/rerouted emits an info card with from/to/reason', async () => {
    const h = harness();
    await h.send('model/rerouted', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      fromModel: 'gpt-5.5',
      toModel: 'gpt-5.4',
      reason: 'highRiskCyberActivity',
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const info = h.events.find(
      (e): e is Extract<typeof e, { type: 'add' }> =>
        e.type === 'add' && (e.card as { text?: string }).text?.includes('Model rerouted') === true,
    );
    expect((info?.card as { text?: string } | undefined)?.text).toMatch(/gpt-5\.5.*gpt-5\.4/);
  });

  it('mcpServer/startupStatus/updated surfaces only failures', async () => {
    const h = harness();
    await h.send('mcpServer/startupStatus/updated', { name: 'foo', status: 'ready', error: null });
    await h.send('mcpServer/startupStatus/updated', { name: 'bar', status: 'failed', error: 'spawn ENOENT' });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const errors = h.events.filter(
      (e): e is Extract<typeof e, { type: 'add' }> =>
        e.type === 'add' && (e.card as { subtype?: string }).subtype === 'error',
    );
    expect(errors).toHaveLength(1);
    expect((errors[0].card as { text?: string }).text).toMatch(/MCP server "bar" failed/);
    expect((errors[0].card as { text?: string }).text).toMatch(/spawn ENOENT/);
  });
});

describe('cardAdapter — surfaced ThreadItem variants', () => {
  it('imageView item emits a system info card with the path', async () => {
    const h = harness();
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'imageView', id: 'img_1', path: '/tmp/cat.png' },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const info = h.events.find(
      (e): e is Extract<typeof e, { type: 'add' }> =>
        e.type === 'add' && (e.card as { text?: string }).text?.includes('/tmp/cat.png') === true,
    );
    expect(info).toBeTruthy();
  });

  it('imageGeneration emits info on started and completed', async () => {
    const h = harness();
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'imageGeneration', id: 'img_2', status: 'pending', revisedPrompt: 'a sleeping cat', result: '' },
    });
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'imageGeneration',
        id: 'img_2',
        status: 'completed',
        revisedPrompt: 'a sleeping cat',
        result: 'ok',
        savedPath: '/tmp/cat.png',
      },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const cards = h.events.filter(
      (e): e is Extract<typeof e, { type: 'add' }> =>
        e.type === 'add' && (e.card as { text?: string }).text?.includes('image') === true,
    );
    // Started + completed both emit; completed includes the savedPath.
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(cards[cards.length - 1].card as { text?: string }).toMatchObject({
      text: expect.stringContaining('/tmp/cat.png'),
    });
  });

  it('enteredReviewMode + exitedReviewMode emit info cards', async () => {
    const h = harness();
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'enteredReviewMode', id: 'rev_1', review: 'security audit' },
    });
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: { type: 'exitedReviewMode', id: 'rev_1', review: 'security audit' },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const reviewCards = h.events.filter(
      (e): e is Extract<typeof e, { type: 'add' }> =>
        e.type === 'add' && (e.card as { text?: string }).text?.includes('review mode') === true,
    );
    expect(reviewCards).toHaveLength(2);
    expect((reviewCards[0].card as { text?: string }).text).toMatch(/Entered review mode/);
    expect((reviewCards[1].card as { text?: string }).text).toMatch(/Exited review mode/);
  });

  it('collabAgentToolCall emits a tool_call card with the prompt', async () => {
    const h = harness();
    await h.send('item/started', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'collabAgentToolCall',
        id: 'collab_1',
        tool: { type: 'spawnAgent' },
        status: 'inProgress',
        senderThreadId: 'thr_test',
        receiverThreadIds: ['child_1'],
        prompt: 'investigate the bug',
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      },
    });
    await h.send('item/completed', {
      threadId: 'thr_test',
      turnId: 'turn_1',
      item: {
        type: 'collabAgentToolCall',
        id: 'collab_1',
        tool: { type: 'spawnAgent' },
        status: 'completed',
        senderThreadId: 'thr_test',
        receiverThreadIds: ['child_1'],
        prompt: 'investigate the bug',
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      },
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const toolAdds = h.events.filter(
      (e): e is Extract<typeof e, { type: 'add' }> =>
        e.type === 'add' && (e.card as { type?: string }).type === 'tool_call',
    );
    expect(toolAdds.length).toBeGreaterThanOrEqual(1);
    expect((toolAdds[0].card as { toolName?: string }).toolName).toMatch(/^collab:/);
  });
});

describe('cardAdapter — turn id isolation (R6)', () => {
  it('ignores notifications for other turn ids', async () => {
    const h = harness({ turnId: 'turn_correct' });
    await h.send('item/agentMessage/delta', {
      threadId: 'thr_test',
      turnId: 'turn_other',
      itemId: 'msg_x',
      delta: 'should be ignored',
    });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_correct', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const text = h.events
      .filter((e) => e.type === 'add' && (e.card as { type?: string }).type === 'assistant_text')
      .map((e) => (e as { card: { text: string } }).card.text)
      .join('');
    expect(text).toBe('');
  });
});

describe('cardAdapter — warning notifications', () => {
  it('warning/configWarning/deprecationNotice all map to system warning cards', async () => {
    const h = harness();
    await h.send('warning', { threadId: 'thr_test', message: 'soft warning' });
    await h.send('configWarning', { summary: 'config thing', details: null, path: null, range: null });
    await h.send('deprecationNotice', { message: 'method X is deprecated' });
    await h.send('turn/completed', {
      threadId: 'thr_test',
      turn: { id: 'turn_1', items: [], status: 'completed', error: null, startedAt: 0, completedAt: 0, durationMs: 0 },
    });
    await h.consume;
    const warnings = h.events.filter(
      (e) =>
        e.type === 'add' &&
        (e.card as { type?: string }).type === 'system' &&
        (e.card as { subtype?: string }).subtype === 'warning',
    );
    // configWarning has `summary` not `message`, so we expect 2 warnings carrying `message`.
    // The dispatcher reads `params.message` only — so configWarning falls back to the method name.
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});
