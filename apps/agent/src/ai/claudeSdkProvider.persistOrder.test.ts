// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Regression: when a `claude:start` / `claude:resume` carries attachments,
 * the provider must finish writing them to the on-disk attachment store
 * BEFORE its stream consumer emits the userMessage card with real
 * attachment UUIDs. Otherwise the PWA chip — which renders from that card
 * and immediately fires `attachment:fetch` — races the disk write and
 * surfaces "Unavailable" because `loadAttachment` returns null.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const { queryMock, persistMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  persistMock: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

vi.mock('./attachmentStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./attachmentStore.js')>();
  return {
    ...actual,
    persistAttachments: persistMock,
  };
});

import { ClaudeSdkProvider } from './claudeSdkProvider.js';
import { StreamCardBuilder } from './cardBuilder.js';
import type { ProviderCallbacks } from './provider.js';
import type { Attachment } from '@sumicom/quicksave-shared';
import { setQuicksaveDir } from '../service/singleton.js';

const SESSION_ID = 'sess-persist-order-1';

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

function makeCallbacks() {
  const cardEvents: any[] = [];
  const eventOrder: string[] = [];
  let resolveStreamEnd!: () => void;
  const streamEnded = new Promise<void>((r) => { resolveStreamEnd = r; });
  const callbacks: ProviderCallbacks = {
    emitCardEvent: (e) => {
      cardEvents.push(e);
      eventOrder.push(`emit:${e.type}:${(e as any).card?.type ?? '?'}`);
    },
    emitStreamEnd: () => { resolveStreamEnd(); },
    handlePermissionRequest: vi.fn().mockResolvedValue({ action: 'allow' as const }),
    onModelDetected: vi.fn(),
  };
  return { callbacks, cardEvents, eventOrder, streamEnded };
}

const sampleAttachment: Attachment = {
  id: 'att-1',
  kind: 'pdf',
  mimeType: 'application/pdf',
  name: 'sample.pdf',
  size: 1024,
  data: Buffer.from('%PDF-1.4 dummy'.padEnd(1024, '.')).toString('base64'),
};

describe('SdkProvider attachment persistence ordering', () => {
  let testDir: string;

  beforeEach(async () => {
    queryMock.mockReset();
    persistMock.mockReset();
    testDir = join(tmpdir(), `qs-persist-order-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    setQuicksaveDir(testDir);
  });

  it('awaits persistAttachments BEFORE the stream consumer fires the user card', async () => {
    // Slow the persist so an out-of-order emit would be visible.
    let resolvePersist!: () => void;
    const persistGate = new Promise<void>((r) => { resolvePersist = r; });
    persistMock.mockImplementation(async () => { await persistGate; });

    queryMock.mockImplementation(() => makeQueryHandle([initMsg, successResult]));

    const { callbacks, eventOrder, streamEnded } = makeCallbacks();
    const cb = new StreamCardBuilder(SESSION_ID, '/tmp/persist-order-cwd');
    const provider = new ClaudeSdkProvider();

    const startPromise = provider.startSession(
      {
        prompt: 'inspect this',
        cwd: '/tmp/persist-order-cwd',
        permissionLevel: 'default',
        sandboxed: false,
        attachments: [sampleAttachment],
      },
      cb,
      callbacks,
    );

    // Yield repeatedly to give consumeStream a chance to emit if it's not
    // gated. Nothing should land yet — startSession is parked on persist.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(eventOrder).toEqual([]);
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(persistMock).toHaveBeenCalledWith(SESSION_ID, [sampleAttachment]);

    resolvePersist();
    await startPromise;
    await streamEnded;
    await new Promise((r) => setImmediate(r));

    // After persist resolves, the user card emits.
    const userEmits = eventOrder.filter((s) => s === 'emit:add:user');
    expect(userEmits).toHaveLength(1);
  });

  it('skips persistAttachments when no attachments are provided', async () => {
    queryMock.mockImplementation(() => makeQueryHandle([initMsg, successResult]));

    const { callbacks, streamEnded } = makeCallbacks();
    const cb = new StreamCardBuilder(SESSION_ID, '/tmp/persist-order-cwd');
    const provider = new ClaudeSdkProvider();

    await provider.startSession(
      {
        prompt: 'no attachments here',
        cwd: '/tmp/persist-order-cwd',
        permissionLevel: 'default',
        sandboxed: false,
      },
      cb,
      callbacks,
    );
    await streamEnded;

    expect(persistMock).not.toHaveBeenCalled();
  });

  it('also persists before the consumer in resumeSession', async () => {
    let resolvePersist!: () => void;
    const persistGate = new Promise<void>((r) => { resolvePersist = r; });
    persistMock.mockImplementation(async () => { await persistGate; });

    queryMock.mockImplementation(() => makeQueryHandle([initMsg, successResult]));

    const { callbacks, eventOrder, streamEnded } = makeCallbacks();
    const cb = new StreamCardBuilder(SESSION_ID, '/tmp/persist-order-cwd');
    const provider = new ClaudeSdkProvider();

    const resumePromise = provider.resumeSession(
      {
        sessionId: SESSION_ID,
        prompt: 'follow up with attachments',
        cwd: '/tmp/persist-order-cwd',
        permissionLevel: 'default',
        sandboxed: false,
        attachments: [sampleAttachment],
      },
      cb,
      callbacks,
    );

    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(eventOrder).toEqual([]);
    expect(persistMock).toHaveBeenCalledTimes(1);

    resolvePersist();
    await resumePromise;
    await streamEnded;
    await new Promise((r) => setImmediate(r));

    expect(eventOrder.filter((s) => s === 'emit:add:user')).toHaveLength(1);
  });

  afterEach(async () => {
    try { await rm(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
