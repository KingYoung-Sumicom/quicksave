/**
 * Regression: Claude provider sessions must record follow-up prompts in the
 * cardBuilder during sendUserMessage so that getCards on PWA refresh returns
 * the user prompt before the SDK/CLI flushes it to the session JSONL.
 *
 * Pre-fix bug: SessionManager used to call cardBuilder.userMessage() during
 * hot resume; commit 0d63d2d removed that call assuming the provider would
 * handle it, but the Claude providers' sendUserMessage only forwarded to
 * stdin/inputQueue without touching cardBuilder. After refresh the user
 * prompt was missing from the chat view.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { CliProviderSession } from './claudeCliProvider.js';
import { SdkProviderSession } from './claudeSdkProvider.js';
import { StreamCardBuilder } from './cardBuilder.js';
import { AsyncQueue } from './asyncQueue.js';

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
    const cardBuilder = new StreamCardBuilder('sess-1', 'stream-1', '/tmp');
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
    const cardBuilder = new StreamCardBuilder('sess-1', 'stream-1', '/tmp');
    const session = new CliProviderSession(proc);
    session.cardBuilder = cardBuilder;

    session.sendUserMessage('hi');

    expect(stdinWrites).toHaveLength(1);
    const sent = JSON.parse(stdinWrites[0].trim());
    expect(sent).toEqual({ type: 'user', message: { role: 'user', content: 'hi' } });
  });

  it('marks the turn active so the idle clock pauses immediately', () => {
    const { proc } = makeFakeProcess();
    const cardBuilder = new StreamCardBuilder('sess-1', 'stream-1', '/tmp');
    const session = new CliProviderSession(proc);
    session.cardBuilder = cardBuilder;
    expect(session.activeTurn).toBe(false);

    session.sendUserMessage('hi');

    expect(session.activeTurn).toBe(true);
  });

  it('is a no-op if the process is dead (no card recorded, no stdin write)', () => {
    const { proc, stdinWrites } = makeFakeProcess();
    (proc as any).killed = true;
    const cardBuilder = new StreamCardBuilder('sess-1', 'stream-1', '/tmp');
    const session = new CliProviderSession(proc);
    session.cardBuilder = cardBuilder;

    session.sendUserMessage('hi');

    expect(cardBuilder.getCards()).toHaveLength(0);
    expect(stdinWrites).toHaveLength(0);
  });
});

describe('SdkProviderSession.sendUserMessage', () => {
  it('records the prompt in cardBuilder so getCards returns it on refresh', () => {
    const cardBuilder = new StreamCardBuilder('sess-1', 'stream-1', '/tmp');
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
    const cardBuilder = new StreamCardBuilder('sess-1', 'stream-1', '/tmp');
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
    const cardBuilder = new StreamCardBuilder('sess-1', 'stream-1', '/tmp');
    const inputQueue = new AsyncQueue<any>();
    const queryHandle = { interrupt: vi.fn(), close: vi.fn() } as any;
    const session = new SdkProviderSession(queryHandle, inputQueue, cardBuilder);

    session.kill();
    session.sendUserMessage('hi');

    expect(cardBuilder.getCards()).toHaveLength(0);
  });
});
