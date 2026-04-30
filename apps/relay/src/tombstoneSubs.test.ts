// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { TombstoneSubs } from './tombstoneSubs.js';

// -----------------------------------------------------------------------
// Mock the sendMessage helper so we can inspect what was pushed without
// standing up a real WS server.
// -----------------------------------------------------------------------

const sendMessageMock = vi.fn();
vi.mock('@sumicom/ws-relay', () => ({
  sendMessage: (ws: WebSocket, msg: unknown) => sendMessageMock(ws, msg),
}));

// Minimal fake matching the WebSocket fields the store touches.
function fakeSocket(readyState: number = WebSocket.OPEN): WebSocket {
  return { readyState } as unknown as WebSocket;
}

describe('TombstoneSubs', () => {
  let subs: TombstoneSubs;

  beforeEach(() => {
    subs = new TombstoneSubs();
    sendMessageMock.mockClear();
  });

  it('subscribe adds a socket and counts it', () => {
    const ws = fakeSocket();
    subs.subscribe('keyA', ws);
    expect(subs.subscriberCount('keyA')).toBe(1);
    expect(subs.stats).toEqual({ keys: 1, subscribers: 1 });
  });

  it('subscribe is idempotent for the same socket', () => {
    const ws = fakeSocket();
    subs.subscribe('keyA', ws);
    subs.subscribe('keyA', ws);
    expect(subs.subscriberCount('keyA')).toBe(1);
  });

  it('subscribe ignores non-OPEN sockets (defensive)', () => {
    const ws = fakeSocket(WebSocket.CLOSED);
    subs.subscribe('keyA', ws);
    expect(subs.subscriberCount('keyA')).toBe(0);
  });

  it('two different sockets on the same key both count', () => {
    const wsA = fakeSocket();
    const wsB = fakeSocket();
    subs.subscribe('keyA', wsA);
    subs.subscribe('keyA', wsB);
    expect(subs.subscriberCount('keyA')).toBe(2);
  });

  it('unsubscribe removes the socket and drops empty entries', () => {
    const ws = fakeSocket();
    subs.subscribe('keyA', ws);
    subs.unsubscribe('keyA', ws);
    expect(subs.subscriberCount('keyA')).toBe(0);
    expect(subs.stats.keys).toBe(0);
  });

  it('unsubscribe for an unknown key is a no-op', () => {
    const ws = fakeSocket();
    expect(() => subs.unsubscribe('missing', ws)).not.toThrow();
  });

  it('unsubscribeAll removes a socket from every key it was on', () => {
    const ws = fakeSocket();
    const other = fakeSocket();
    subs.subscribe('keyA', ws);
    subs.subscribe('keyB', ws);
    subs.subscribe('keyB', other);

    subs.unsubscribeAll(ws);

    expect(subs.subscriberCount('keyA')).toBe(0);
    expect(subs.subscriberCount('keyB')).toBe(1); // `other` survives
    expect(subs.stats).toEqual({ keys: 1, subscribers: 1 });
  });

  it('publish fans out to every subscribed socket of that key', () => {
    const wsA = fakeSocket();
    const wsB = fakeSocket();
    const wsC = fakeSocket();
    subs.subscribe('keyA', wsA);
    subs.subscribe('keyA', wsB);
    subs.subscribe('keyOther', wsC);

    subs.publish('keyA', 'ciphertext-blob');

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    const [firstArgs, secondArgs] = sendMessageMock.mock.calls;
    expect(firstArgs[1]).toEqual({
      type: 'tombstone-event',
      payload: { keyHash: 'keyA', data: 'ciphertext-blob' },
    });
    expect(secondArgs[1]).toEqual({
      type: 'tombstone-event',
      payload: { keyHash: 'keyA', data: 'ciphertext-blob' },
    });
    // Subscribers on other keys are not paged.
    expect(sendMessageMock.mock.calls.map((c) => c[0])).not.toContain(wsC);
  });

  it('publish with no subscribers is a no-op', () => {
    subs.publish('keyA', 'ciphertext');
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('publish skips + prunes sockets that have closed since subscribe', () => {
    const alive = fakeSocket();
    const dead = fakeSocket(WebSocket.CLOSED);
    subs.subscribe('keyA', alive);
    // Force-insert a dead socket bypassing the OPEN guard in subscribe.
    (subs as unknown as { byKey: Map<string, Set<WebSocket>> }).byKey
      .get('keyA')!
      .add(dead);
    expect(subs.subscriberCount('keyA')).toBe(2);

    subs.publish('keyA', 'blob');

    // Only the live socket got the message.
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    // Dead socket got reaped.
    expect(subs.subscriberCount('keyA')).toBe(1);
  });

  it('publish drops the key entry when every subscriber was stale', () => {
    const dead = fakeSocket(WebSocket.CLOSED);
    (subs as unknown as { byKey: Map<string, Set<WebSocket>> }).byKey.set(
      'keyA',
      new Set([dead]),
    );
    expect(subs.stats.keys).toBe(1);

    subs.publish('keyA', 'blob');

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(subs.stats.keys).toBe(0);
  });
});
