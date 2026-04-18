import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createMessage, type Message } from '@sumicom/quicksave-shared';
import type {
  ClientFrame,
  ServerFrame,
} from '@sumicom/quicksave-message-bus';
import { BusServerTransport } from './busServerTransport.js';

// ── Stubs ──

/**
 * Minimal stand-in for the real AgentConnection. The BusServerTransport only
 * cares that it can subscribe to `'message' | 'connected' | 'disconnected'`
 * and call `send(message, peerAddress)`.
 */
class FakeAgentConnection extends EventEmitter {
  public sendCalls: Array<{ message: Message; peer: string }> = [];

  send(message: Message, targetAddress: string): void {
    this.sendCalls.push({ message, peer: targetAddress });
  }
}

function makeTransport() {
  const connection = new FakeAgentConnection();
  // The adapter accepts an AgentConnection; our fake satisfies the shape used.
  const transport = new BusServerTransport(
    connection as unknown as import('../connection/connection.js').AgentConnection
  );
  return { connection, transport };
}

function cmdFrame(overrides: Partial<ClientFrame> = {}): ClientFrame {
  return {
    kind: 'cmd',
    id: 'cmd-1',
    verb: 'repo.list',
    payload: { foo: 'bar' },
    ...overrides,
  } as ClientFrame;
}

function snapFrame(overrides: Partial<ServerFrame> = {}): ServerFrame {
  return {
    kind: 'snap',
    path: '/repos',
    data: { a: 1 },
    ...overrides,
  } as ServerFrame;
}

// ── Tests ──

describe('BusServerTransport — inbound filtering', () => {
  it('fires onFrame with (peer, payload) when connection emits a bus:frame message', () => {
    const { connection, transport } = makeTransport();
    const handler = vi.fn();
    transport.onFrame(handler);

    const frame = cmdFrame();
    const envelope = createMessage('bus:frame', frame);
    connection.emit('message', envelope, 'peer-A');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('peer-A', frame);
  });

  it('does NOT fire onFrame when connection emits a non-bus:frame message', () => {
    const { connection, transport } = makeTransport();
    const handler = vi.fn();
    transport.onFrame(handler);

    const envelope = createMessage('git:status', { branch: 'main' });
    connection.emit('message', envelope, 'peer-A');

    const envelope2 = createMessage('claude:start', { cwd: '/x' });
    connection.emit('message', envelope2, 'peer-B');

    expect(handler).not.toHaveBeenCalled();
  });

  it('invokes multiple onFrame handlers in registration order on a single bus:frame', () => {
    const { connection, transport } = makeTransport();
    const order: string[] = [];
    transport.onFrame(() => {
      order.push('first');
    });
    transport.onFrame(() => {
      order.push('second');
    });
    transport.onFrame(() => {
      order.push('third');
    });

    const envelope = createMessage('bus:frame', cmdFrame());
    connection.emit('message', envelope, 'peer-A');

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('forwards the exact payload shape as the ClientFrame', () => {
    const { connection, transport } = makeTransport();
    const handler = vi.fn();
    transport.onFrame(handler);

    const frame: ClientFrame = {
      kind: 'sub',
      path: '/agent/repos',
    };
    connection.emit('message', createMessage('bus:frame', frame), 'peer-X');

    expect(handler).toHaveBeenCalledWith('peer-X', frame);
  });
});

describe('BusServerTransport — outbound send', () => {
  it('wraps the frame in a bus:frame envelope addressed to the peer', () => {
    const { connection, transport } = makeTransport();
    const frame = snapFrame();

    transport.send('peer-A', frame);

    expect(connection.sendCalls).toHaveLength(1);
    const call = connection.sendCalls[0];
    expect(call.peer).toBe('peer-A');
    expect(call.message).toMatchObject({
      type: 'bus:frame',
      payload: frame,
    });
    expect(typeof call.message.id).toBe('string');
    expect(call.message.id.length).toBeGreaterThan(0);
    expect(typeof call.message.timestamp).toBe('number');
  });

  it('generates distinct envelope ids for successive sends', () => {
    const { connection, transport } = makeTransport();

    transport.send('peer-A', snapFrame());
    transport.send('peer-A', snapFrame({ path: '/other' }));

    expect(connection.sendCalls).toHaveLength(2);
    const id1 = connection.sendCalls[0].message.id;
    const id2 = connection.sendCalls[1].message.id;
    expect(id1).not.toBe(id2);
  });

  it('deep-equals the frame in payload without mutating it', () => {
    const { connection, transport } = makeTransport();
    const frame: ServerFrame = {
      kind: 'result',
      id: 'r-1',
      ok: true,
      data: { nested: { list: [1, 2, 3] } },
    };

    transport.send('peer-Z', frame);

    expect(connection.sendCalls[0].message.payload).toEqual(frame);
  });
});

describe('BusServerTransport — peer lifecycle', () => {
  it("fires every onPeerConnected handler once when connection emits 'connected'", () => {
    const { connection, transport } = makeTransport();
    const h1 = vi.fn();
    const h2 = vi.fn();
    transport.onPeerConnected(h1);
    transport.onPeerConnected(h2);

    connection.emit('connected', 'peer-A');

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h1).toHaveBeenCalledWith('peer-A');
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledWith('peer-A');
  });

  it("fires every onPeerDisconnected handler once when connection emits 'disconnected'", () => {
    const { connection, transport } = makeTransport();
    const h1 = vi.fn();
    const h2 = vi.fn();
    transport.onPeerDisconnected(h1);
    transport.onPeerDisconnected(h2);

    connection.emit('disconnected', 'peer-A');

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h1).toHaveBeenCalledWith('peer-A');
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledWith('peer-A');
  });

  it('does not replay past connected/disconnected events to late-registered handlers', () => {
    const { connection, transport } = makeTransport();

    connection.emit('connected', 'peer-early');
    connection.emit('disconnected', 'peer-early');

    const lateConnected = vi.fn();
    const lateDisconnected = vi.fn();
    transport.onPeerConnected(lateConnected);
    transport.onPeerDisconnected(lateDisconnected);

    expect(lateConnected).not.toHaveBeenCalled();
    expect(lateDisconnected).not.toHaveBeenCalled();
  });

  it('keeps connected and disconnected handler sets independent', () => {
    const { connection, transport } = makeTransport();
    const connectedH = vi.fn();
    const disconnectedH = vi.fn();
    transport.onPeerConnected(connectedH);
    transport.onPeerDisconnected(disconnectedH);

    connection.emit('connected', 'peer-A');
    expect(connectedH).toHaveBeenCalledTimes(1);
    expect(disconnectedH).not.toHaveBeenCalled();

    connection.emit('disconnected', 'peer-A');
    expect(connectedH).toHaveBeenCalledTimes(1);
    expect(disconnectedH).toHaveBeenCalledTimes(1);
  });
});
