/**
 * Regression: Claude provider sessions must record follow-up prompts in the
 * cardBuilder during sendUserMessage so that getCards on PWA refresh returns
 * the user prompt before the SDK/CLI flushes it to the session JSONL.
 *
 * Multi-tab regression: providers must ALSO emit the user-message card-event
 * so a second PWA tab subscribed to the same session sees the prompt in real
 * time. Pre-fix the comment said "PWA already shows an optimistic user card,
 * so we don't emit" — true for the sending tab but leaves other tabs blind.
 * The PWA's claudeStore dedupes by text + recent timestamp so the sending
 * tab still sees only one card.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { CliProviderSession } from './claudeCliProvider.js';
import { SdkProviderSession } from './claudeSdkProvider.js';
import { StreamCardBuilder } from './cardBuilder.js';
import { AsyncQueue } from './asyncQueue.js';
import type { ProviderCallbacks } from './provider.js';

function makeCallbacks(): { callbacks: ProviderCallbacks; emitted: any[] } {
  const emitted: any[] = [];
  const callbacks: ProviderCallbacks = {
    emitCardEvent: (e) => emitted.push(e),
    emitStreamEnd: vi.fn(),
    handlePermissionRequest: vi.fn().mockResolvedValue({ action: 'allow' as const }),
    onModelDetected: vi.fn(),
  };
  return { callbacks, emitted };
}

function makeFakeProcess(): { proc: ChildProcess; stdinWrites: string[] } {
  const stdinWrites: string[] = [];
  const proc = new EventEmitter() as unknown as ChildProcess;
  (proc as any).killed = false;
  (proc as any).stdin = {
    write: (chunk: string) => {
      stdinWrites.push(chunk);
      return true;
    },
  };
  return { proc, stdinWrites };
}

describe('CliProviderSession.sendUserMessage', () => {
  it('records the prompt in cardBuilder so getCards returns it on refresh', () => {
    const { proc } = makeFakeProcess();
    const cardBuilder = new StreamCardBuilder('sess-1', '/tmp');
    const session = new CliProviderSession(proc);
    session.cardBuilder = cardBuilder;

    expect(cardBuilder.getCards()).toHaveLength(0);

    session.sendUserMessage('hello, follow-up prompt');

    const cards = cardBuilder.getCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('user');
    expect((cards[0] as any).text).toBe('hello, follow-up prompt');
  });

  it('still writes the prompt to the CLI stdin', () => {
    const { proc, stdinWrites } = makeFakeProcess();
    const cardBuilder = new StreamCardBuilder('sess-1', '/tmp');
    const session = new CliProviderSession(proc);
    session.cardBuilder = cardBuilder;

    session.sendUserMessage('hi');

    expect(stdinWrites).toHaveLength(1);
    const sent = JSON.parse(stdinWrites[0].trim());
    expect(sent).toEqual({ type: 'user', message: { role: 'user', content: 'hi' } });
  });

  it('marks the turn active so the idle clock pauses immediately', () => {
    const { proc } = makeFakeProcess();
    const cardBuilder = new StreamCardBuilder('sess-1', '/tmp');
    const session = new CliProviderSession(proc);
    session.cardBuilder = cardBuilder;
    expect(session.activeTurn).toBe(false);

    session.sendUserMessage('hi');

    expect(session.activeTurn).toBe(true);
  });

  it('is a no-op if the process is dead (no card recorded, no stdin write)', () => {
    const { proc, stdinWrites } = makeFakeProcess();
    (proc as any).killed = true;
    const cardBuilder = new StreamCardBuilder('sess-1', '/tmp');
    const session = new CliProviderSession(proc);
    session.cardBuilder = cardBuilder;

    session.sendUserMessage('hi');

    expect(cardBuilder.getCards()).toHaveLength(0);
    expect(stdinWrites).toHaveLength(0);
  });
});

describe('SdkProviderSession.sendUserMessage', () => {
  it('records the prompt in cardBuilder so getCards returns it on refresh', () => {
    const cardBuilder = new StreamCardBuilder('sess-1', '/tmp');
    const inputQueue = new AsyncQueue<any>();
    const queryHandle = { interrupt: vi.fn(), close: vi.fn() } as any;
    const session = new SdkProviderSession(queryHandle, inputQueue, cardBuilder);

    expect(cardBuilder.getCards()).toHaveLength(0);

    session.sendUserMessage('follow-up prompt');

    const cards = cardBuilder.getCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('user');
    expect((cards[0] as any).text).toBe('follow-up prompt');
  });

  it('still pushes the prompt onto the SDK input queue', () => {
    const cardBuilder = new StreamCardBuilder('sess-1', '/tmp');
    const inputQueue = new AsyncQueue<any>();
    const pushSpy = vi.spyOn(inputQueue, 'push');
    const queryHandle = { interrupt: vi.fn(), close: vi.fn() } as any;
    const session = new SdkProviderSession(queryHandle, inputQueue, cardBuilder);

    session.sendUserMessage('hi');

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0][0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hi' },
    });
  });

  it('is a no-op if the query handle has been closed (no card recorded)', () => {
    const cardBuilder = new StreamCardBuilder('sess-1', '/tmp');
    const inputQueue = new AsyncQueue<any>();
    const queryHandle = { interrupt: vi.fn(), close: vi.fn() } as any;
    const session = new SdkProviderSession(queryHandle, inputQueue, cardBuilder);

    session.kill();
    session.sendUserMessage('hi');

    expect(cardBuilder.getCards()).toHaveLength(0);
  });
});

describe('multi-tab regression: providers emit user-message card-event on follow-up', () => {
  it('CliProviderSession.sendUserMessage emits an add card-event with the user prompt', () => {
    const { proc } = makeFakeProcess();
    const cardBuilder = new StreamCardBuilder('sess-1', '/tmp');
    const session = new CliProviderSession(proc);
    session.cardBuilder = cardBuilder;
    const { callbacks, emitted } = makeCallbacks();
    session.callbacks = callbacks;

    session.sendUserMessage('follow-up from another tab');

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'add',
      sessionId: 'sess-1',
      card: { type: 'user', text: 'follow-up from another tab' },
    });
  });

  it('CliProviderSession.sendUserMessage with no callbacks wired still records (no crash)', () => {
    const { proc } = makeFakeProcess();
    const cardBuilder = new StreamCardBuilder('sess-1', '/tmp');
    const session = new CliProviderSession(proc);
    session.cardBuilder = cardBuilder;
    // callbacks intentionally not set

    expect(() => session.sendUserMessage('hi')).not.toThrow();
    expect(cardBuilder.getCards()).toHaveLength(1);
  });

  it('SdkProviderSession.sendUserMessage emits an add card-event with the user prompt', () => {
    const cardBuilder = new StreamCardBuilder('sess-1', '/tmp');
    const inputQueue = new AsyncQueue<any>();
    const queryHandle = { interrupt: vi.fn(), close: vi.fn() } as any;
    const session = new SdkProviderSession(queryHandle, inputQueue, cardBuilder);
    const { callbacks, emitted } = makeCallbacks();
    session.callbacks = callbacks;

    session.sendUserMessage('multi-tab follow-up');

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'add',
      sessionId: 'sess-1',
      card: { type: 'user', text: 'multi-tab follow-up' },
    });
  });

  it('SdkProviderSession.sendUserMessage with no callbacks wired still records (no crash)', () => {
    const cardBuilder = new StreamCardBuilder('sess-1', '/tmp');
    const inputQueue = new AsyncQueue<any>();
    const queryHandle = { interrupt: vi.fn(), close: vi.fn() } as any;
    const session = new SdkProviderSession(queryHandle, inputQueue, cardBuilder);
    // callbacks intentionally not set

    expect(() => session.sendUserMessage('hi')).not.toThrow();
    expect(cardBuilder.getCards()).toHaveLength(1);
  });
});
