// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Regression: when the SDK rewrites an Anthropic API rejection (e.g.
 * "PDF too large (max 100 pages, 20MB)") into a faux assistant text block,
 * the SdkProvider must surface a recovery_suggested card after the result
 * so the user can click /compact to unstick the session — without that, the
 * same rejection replays on every resume because the bad blob stays in the
 * session JSONL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

import { ClaudeSdkProvider } from './claudeSdkProvider.js';
import { StreamCardBuilder } from './cardBuilder.js';
import type { ProviderCallbacks } from './provider.js';

function makeCallbacks() {
  const cardEvents: any[] = [];
  let resolveStreamEnd!: (v?: unknown) => void;
  const streamEnded = new Promise((r) => { resolveStreamEnd = r; });
  const callbacks: ProviderCallbacks = {
    emitCardEvent: (e) => cardEvents.push(e),
    emitStreamEnd: () => { resolveStreamEnd(); },
    handlePermissionRequest: vi.fn().mockResolvedValue({ action: 'allow' as const }),
    onModelDetected: vi.fn(),
  };
  return { callbacks, cardEvents, streamEnded };
}

/** Build a minimal SDK Query mock that yields a scripted message sequence. */
function makeQueryHandle(messages: any[]) {
  let idx = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (idx >= messages.length) return { value: undefined, done: true };
      return { value: messages[idx++], done: false };
    },
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

const SESSION_ID = 'sess-poison-1';

const initMsg = {
  type: 'system',
  subtype: 'init',
  session_id: SESSION_ID,
  model: 'claude-sonnet-4-6',
};

const successResult = {
  type: 'result',
  subtype: 'success',
  session_id: SESSION_ID,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
};

beforeEach(() => {
  queryMock.mockReset();
});

describe('SdkProvider poison detection', () => {
  it('emits a recovery_suggested card after the result when an assistant block matches the PDF-too-large pattern', async () => {
    queryMock.mockImplementation(() => makeQueryHandle([
      initMsg,
      {
        type: 'assistant',
        session_id: SESSION_ID,
        message: {
          content: [{
            type: 'text',
            text: 'PDF too large (max 100 pages, 20MB). Try reading the file a different way (e.g., extract text with pdftotext)',
          }],
        },
      },
      successResult,
    ]));

    const { callbacks, cardEvents, streamEnded } = makeCallbacks();
    const cb = new StreamCardBuilder(SESSION_ID, '/tmp/quicksave-poison-test-cwd');
    const provider = new ClaudeSdkProvider();

    await provider.startSession(
      { prompt: 'hi', cwd: '/tmp/quicksave-poison-test-cwd', permissionLevel: 'default', sandboxed: false },
      cb,
      callbacks,
    );
    await streamEnded;
    // consumeStream awaits one more loop iteration after emitStreamEnd before
    // the recovery card is emitted; yield once so the microtask drains.
    await new Promise((r) => setImmediate(r));

    const recoveryAdds = cardEvents.filter(
      (e) => e.type === 'add' && e.card?.type === 'recovery_suggested',
    );
    expect(recoveryAdds).toHaveLength(1);
    expect(recoveryAdds[0].card).toMatchObject({
      type: 'recovery_suggested',
      action: 'compact',
      label: 'Compact to recover',
    });
    expect(recoveryAdds[0].card.reason).toMatch(/stuck|compact/i);
  });

  it('also detects the poison pattern when the rejection arrives via streaming text deltas', async () => {
    queryMock.mockImplementation(() => makeQueryHandle([
      initMsg,
      // Streamed text — the buffer is flushed at the next assistant message
      // or at the result branch via flushText().
      {
        type: 'stream_event',
        session_id: SESSION_ID,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'PDF too large (max 100 pages' } },
      },
      {
        type: 'stream_event',
        session_id: SESSION_ID,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ', 20MB).' } },
      },
      successResult,
    ]));

    const { callbacks, cardEvents, streamEnded } = makeCallbacks();
    const cb = new StreamCardBuilder(SESSION_ID, '/tmp/quicksave-poison-test-cwd');
    const provider = new ClaudeSdkProvider();

    await provider.startSession(
      { prompt: 'hi', cwd: '/tmp/quicksave-poison-test-cwd', permissionLevel: 'default', sandboxed: false },
      cb,
      callbacks,
    );
    await streamEnded;
    await new Promise((r) => setImmediate(r));

    const recoveryAdds = cardEvents.filter(
      (e) => e.type === 'add' && e.card?.type === 'recovery_suggested',
    );
    expect(recoveryAdds).toHaveLength(1);
  });

  it('does NOT emit a recovery card on a normal successful turn', async () => {
    queryMock.mockImplementation(() => makeQueryHandle([
      initMsg,
      {
        type: 'assistant',
        session_id: SESSION_ID,
        message: { content: [{ type: 'text', text: 'Sure, here is the answer.' }] },
      },
      successResult,
    ]));

    const { callbacks, cardEvents, streamEnded } = makeCallbacks();
    const cb = new StreamCardBuilder(SESSION_ID, '/tmp/quicksave-poison-test-cwd');
    const provider = new ClaudeSdkProvider();

    await provider.startSession(
      { prompt: 'hi', cwd: '/tmp/quicksave-poison-test-cwd', permissionLevel: 'default', sandboxed: false },
      cb,
      callbacks,
    );
    await streamEnded;
    await new Promise((r) => setImmediate(r));

    const recoveryAdds = cardEvents.filter(
      (e) => e.type === 'add' && e.card?.type === 'recovery_suggested',
    );
    expect(recoveryAdds).toHaveLength(0);
  });

  it('matches the other poison patterns we ship (image too large, prompt too long, request too large)', async () => {
    const samples = [
      'Image was too large to process',
      'image dimensions exceed the maximum allowed',
      'Request too large for model',
      'Prompt is too long: 250000 tokens > max 200000',
      'PDF is password protected',
      'PDF file was not valid',
    ];

    for (const text of samples) {
      queryMock.mockImplementation(() => makeQueryHandle([
        initMsg,
        { type: 'assistant', session_id: SESSION_ID, message: { content: [{ type: 'text', text }] } },
        successResult,
      ]));

      const { callbacks, cardEvents, streamEnded } = makeCallbacks();
      const cb = new StreamCardBuilder(SESSION_ID, '/tmp/quicksave-poison-test-cwd');
      const provider = new ClaudeSdkProvider();

      await provider.startSession(
        { prompt: 'hi', cwd: '/tmp/quicksave-poison-test-cwd', permissionLevel: 'default', sandboxed: false },
        cb,
        callbacks,
      );
      await streamEnded;
      await new Promise((r) => setImmediate(r));

      const recoveryAdds = cardEvents.filter(
        (e) => e.type === 'add' && e.card?.type === 'recovery_suggested',
      );
      expect(recoveryAdds, `expected recovery card for: ${text}`).toHaveLength(1);
    }
  });
});
