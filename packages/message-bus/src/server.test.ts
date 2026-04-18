import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBusServer } from './server.js';
import type { ServerTransport, PeerId } from './transport.js';
import type { ClientFrame, ServerFrame } from './types.js';

class StubTransport implements ServerTransport {
  sent: Array<{ peer: PeerId; frame: ServerFrame }> = [];
  private frameHandler?: (peer: PeerId, frame: ClientFrame) => void;
  private disconnectHandler?: (peer: PeerId) => void;

  send(peer: PeerId, frame: ServerFrame): void {
    this.sent.push({ peer, frame });
  }
  onFrame(handler: (peer: PeerId, frame: ClientFrame) => void): void {
    this.frameHandler = handler;
  }
  onPeerConnected(): void {}
  onPeerDisconnected(handler: (peer: PeerId) => void): void {
    this.disconnectHandler = handler;
  }

  emitFrame(peer: PeerId, frame: ClientFrame): void {
    this.frameHandler?.(peer, frame);
  }
  emitDisconnect(peer: PeerId): void {
    this.disconnectHandler?.(peer);
  }
  lastSent(): { peer: PeerId; frame: ServerFrame } | undefined {
    return this.sent[this.sent.length - 1];
  }
}

describe('MessageBusServer - commands', () => {
  let transport: StubTransport;
  let server: MessageBusServer;

  beforeEach(() => {
    transport = new StubTransport();
    server = new MessageBusServer(transport);
  });

  it('routes a command to its handler and returns the result', async () => {
    server.onCommand<{ a: number; b: number }, number>('add', (p) => p.a + p.b);
    transport.emitFrame('peer1', {
      kind: 'cmd',
      id: '1',
      verb: 'add',
      payload: { a: 2, b: 3 },
    });
    await new Promise((r) => setImmediate(r));
    expect(transport.lastSent()).toEqual({
      peer: 'peer1',
      frame: { kind: 'result', id: '1', ok: true, data: 5 },
    });
  });

  it('returns an error for an unknown verb', async () => {
    transport.emitFrame('peer1', {
      kind: 'cmd',
      id: '2',
      verb: 'nope',
      payload: null,
    });
    await new Promise((r) => setImmediate(r));
    expect(transport.lastSent()?.frame).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unknown command'),
    });
  });

  it('reports an error when the handler throws', async () => {
    server.onCommand('boom', () => {
      throw new Error('handler failure');
    });
    transport.emitFrame('peer1', {
      kind: 'cmd',
      id: '3',
      verb: 'boom',
      payload: null,
    });
    await new Promise((r) => setImmediate(r));
    expect(transport.lastSent()?.frame).toMatchObject({
      ok: false,
      error: 'handler failure',
    });
  });

  it('rejects re-registering the same command', () => {
    server.onCommand('once', () => 'ok');
    expect(() => server.onCommand('once', () => 'ok')).toThrow();
  });
});

describe('MessageBusServer - subscriptions', () => {
  let transport: StubTransport;
  let server: MessageBusServer;

  beforeEach(() => {
    transport = new StubTransport();
    server = new MessageBusServer(transport);
  });

  it('sends snapshot on subscribe and delivers updates only to subscribers', async () => {
    server.onSubscribe<'/sessions/:id', { id: string }, { delta: number }>(
      '/sessions/:id',
      {
        snapshot: ({ params }) => ({ id: params.id }),
      },
    );
    transport.emitFrame('peer1', { kind: 'sub', path: '/sessions/abc' });
    await new Promise((r) => setImmediate(r));
    expect(transport.lastSent()).toEqual({
      peer: 'peer1',
      frame: { kind: 'snap', path: '/sessions/abc', data: { id: 'abc' } },
    });

    const count = server.publish('/sessions/abc', { delta: 1 });
    expect(count).toBe(1);
    expect(transport.lastSent()).toEqual({
      peer: 'peer1',
      frame: { kind: 'upd', path: '/sessions/abc', data: { delta: 1 } },
    });

    // publish to a different path should not reach peer1
    const count2 = server.publish('/sessions/other', { delta: 9 });
    expect(count2).toBe(0);
  });

  it('prefers static patterns over param patterns', async () => {
    const staticSnap = vi.fn(() => ({ which: 'static' }));
    const paramSnap = vi.fn(() => ({ which: 'param' }));
    server.onSubscribe('/sessions/:id', { snapshot: paramSnap });
    server.onSubscribe('/sessions/active', { snapshot: staticSnap });
    transport.emitFrame('peer1', { kind: 'sub', path: '/sessions/active' });
    await new Promise((r) => setImmediate(r));
    expect(staticSnap).toHaveBeenCalled();
    expect(paramSnap).not.toHaveBeenCalled();
    expect(transport.lastSent()?.frame).toMatchObject({
      kind: 'snap',
      data: { which: 'static' },
    });
  });

  it('sends sub-error for an unmatched path', async () => {
    transport.emitFrame('peer1', { kind: 'sub', path: '/unknown' });
    await new Promise((r) => setImmediate(r));
    expect(transport.lastSent()?.frame).toMatchObject({
      kind: 'sub-error',
      path: '/unknown',
    });
  });

  it('fires onSubscribed after successful snapshot', async () => {
    const onSubscribed = vi.fn();
    server.onSubscribe('/x/:id', {
      snapshot: () => 'ok',
      onSubscribed,
    });
    transport.emitFrame('peer1', { kind: 'sub', path: '/x/1' });
    await new Promise((r) => setImmediate(r));
    expect(onSubscribed).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/x/1', params: { id: '1' }, peer: 'peer1' }),
    );
  });

  it('fires onUnsubscribed on unsub', async () => {
    const onUnsubscribed = vi.fn();
    server.onSubscribe('/x/:id', {
      snapshot: () => 'ok',
      onUnsubscribed,
    });
    transport.emitFrame('peer1', { kind: 'sub', path: '/x/1' });
    await new Promise((r) => setImmediate(r));
    transport.emitFrame('peer1', { kind: 'unsub', path: '/x/1' });
    expect(onUnsubscribed).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/x/1', params: { id: '1' } }),
    );
  });

  it('fires onUnsubscribed when peer disconnects', async () => {
    const onUnsubscribed = vi.fn();
    server.onSubscribe('/x/:id', {
      snapshot: () => 'ok',
      onUnsubscribed,
    });
    transport.emitFrame('peer1', { kind: 'sub', path: '/x/1' });
    await new Promise((r) => setImmediate(r));
    transport.emitDisconnect('peer1');
    expect(onUnsubscribed).toHaveBeenCalledTimes(1);
  });

  it('drops subscription on peer disconnect so publish no longer reaches them', async () => {
    server.onSubscribe('/x/:id', { snapshot: () => 'ok' });
    transport.emitFrame('peer1', { kind: 'sub', path: '/x/1' });
    await new Promise((r) => setImmediate(r));
    expect(server.publish('/x/1', 'hi')).toBe(1);
    transport.emitDisconnect('peer1');
    expect(server.publish('/x/1', 'hi')).toBe(0);
  });

  it('sends sub-error when snapshot handler throws', async () => {
    server.onSubscribe('/x/:id', {
      snapshot: () => {
        throw new Error('snap failed');
      },
    });
    transport.emitFrame('peer1', { kind: 'sub', path: '/x/1' });
    await new Promise((r) => setImmediate(r));
    expect(transport.lastSent()?.frame).toMatchObject({
      kind: 'sub-error',
      error: 'snap failed',
    });
    expect(server.publish('/x/1', 'hi')).toBe(0);
  });
});
