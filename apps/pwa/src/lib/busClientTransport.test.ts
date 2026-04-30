// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from 'vitest';
import { createMessage, type Message } from '@sumicom/quicksave-shared';
import type {
  ClientFrame,
  ServerFrame,
} from '@sumicom/quicksave-message-bus';
import { BusClientTransport } from './busClientTransport.js';

// ── Stubs ──

const AGENT_ID = 'agent-1';

/**
 * Minimal WebSocketClient stand-in: records calls to sendToAgent().
 * The per-agent transport routes sends via `sendToAgent(agentId, message)`.
 */
class FakeWebSocketClient {
  public sendCalls: Message[] = [];
  public sendToAgentCalls: Array<{ agentId: string; message: Message }> = [];

  sendToAgent(agentId: string, message: Message): void {
    this.sendToAgentCalls.push({ agentId, message });
    this.sendCalls.push(message);
  }
}

function makeTransport(agentId: string = AGENT_ID) {
  const client = new FakeWebSocketClient();
  const transport = new BusClientTransport(
    client as unknown as import('./websocket.js').WebSocketClient,
    agentId
  );
  return { client, transport };
}

function subFrame(overrides: Partial<ClientFrame> = {}): ClientFrame {
  return {
    kind: 'sub',
    path: '/agent/repos',
    ...overrides,
  } as ClientFrame;
}

function snapFrame(overrides: Partial<ServerFrame> = {}): ServerFrame {
  return {
    kind: 'snap',
    path: '/agent/repos',
    data: [{ id: 1 }],
    ...overrides,
  } as ServerFrame;
}

// ── Tests ──

describe('BusClientTransport — connection state', () => {
  it('starts disconnected', () => {
    const { transport } = makeTransport();
    expect(transport.isConnected()).toBe(false);
  });

  it('notifyConnected transitions to connected and fires all onConnected handlers once', () => {
    const { transport } = makeTransport();
    const h1 = vi.fn();
    const h2 = vi.fn();
    transport.onConnected(h1);
    transport.onConnected(h2);

    transport.notifyConnected();

    expect(transport.isConnected()).toBe(true);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('notifyConnected while already connected is a no-op', () => {
    const { transport } = makeTransport();
    const h = vi.fn();
    transport.onConnected(h);

    transport.notifyConnected();
    transport.notifyConnected();
    transport.notifyConnected();

    expect(transport.isConnected()).toBe(true);
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('notifyDisconnected transitions to disconnected and fires all onDisconnected handlers once', () => {
    const { transport } = makeTransport();
    const h1 = vi.fn();
    const h2 = vi.fn();
    transport.onDisconnected(h1);
    transport.onDisconnected(h2);

    transport.notifyConnected();
    transport.notifyDisconnected();

    expect(transport.isConnected()).toBe(false);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('notifyDisconnected while already disconnected is a no-op', () => {
    const { transport } = makeTransport();
    const h = vi.fn();
    transport.onDisconnected(h);

    transport.notifyDisconnected();
    transport.notifyDisconnected();

    expect(transport.isConnected()).toBe(false);
    expect(h).not.toHaveBeenCalled();
  });

  it('cycles connected <-> disconnected, firing handlers exactly once per transition', () => {
    const { transport } = makeTransport();
    const connected = vi.fn();
    const disconnected = vi.fn();
    transport.onConnected(connected);
    transport.onDisconnected(disconnected);

    transport.notifyConnected();
    transport.notifyDisconnected();
    transport.notifyConnected();
    transport.notifyDisconnected();

    expect(connected).toHaveBeenCalledTimes(2);
    expect(disconnected).toHaveBeenCalledTimes(2);
    expect(transport.isConnected()).toBe(false);
  });

  it('fires handlers in registration order', () => {
    const { transport } = makeTransport();
    const order: string[] = [];
    transport.onConnected(() => order.push('c1'));
    transport.onConnected(() => order.push('c2'));
    transport.onDisconnected(() => order.push('d1'));
    transport.onDisconnected(() => order.push('d2'));

    transport.notifyConnected();
    transport.notifyDisconnected();

    expect(order).toEqual(['c1', 'c2', 'd1', 'd2']);
  });
});

describe('BusClientTransport — reestablished signal', () => {
  it('fires onReestablished handlers and does not flip the connected flag', () => {
    const { transport } = makeTransport();
    const h = vi.fn();
    transport.onReestablished(h);

    expect(transport.isConnected()).toBe(false);
    transport.notifyReestablished();
    expect(h).toHaveBeenCalledTimes(1);
    expect(transport.isConnected()).toBe(false); // unchanged
  });

  it('fires onReestablished every time, regardless of connected state', () => {
    // The whole point of the split: this signal must keep firing even when
    // notifyConnected has already early-returned. Each fresh handshake-ack
    // means the agent wiped the peer's bus subs server-side and the client
    // must re-send them.
    const { transport } = makeTransport();
    const reestablished = vi.fn();
    transport.onReestablished(reestablished);

    transport.notifyConnected();
    transport.notifyReestablished();
    transport.notifyReestablished();
    transport.notifyReestablished();

    expect(reestablished).toHaveBeenCalledTimes(3);
    expect(transport.isConnected()).toBe(true);
  });

  it('does not fire onConnected handlers when notifyReestablished is called', () => {
    const { transport } = makeTransport();
    const connected = vi.fn();
    transport.onConnected(connected);

    transport.notifyReestablished();

    expect(connected).not.toHaveBeenCalled();
  });

  it('fires multiple onReestablished handlers in registration order', () => {
    const { transport } = makeTransport();
    const order: string[] = [];
    transport.onReestablished(() => order.push('r1'));
    transport.onReestablished(() => order.push('r2'));
    transport.onReestablished(() => order.push('r3'));

    transport.notifyReestablished();

    expect(order).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('BusClientTransport — notifyMessage inbound', () => {
  it('returns true and forwards payload to every onFrame handler for bus:frame messages', () => {
    const { transport } = makeTransport();
    const h1 = vi.fn();
    const h2 = vi.fn();
    transport.onFrame(h1);
    transport.onFrame(h2);

    const frame = snapFrame();
    const envelope = createMessage('bus:frame', frame);
    const result = transport.notifyMessage(envelope, AGENT_ID);

    expect(result).toBe(true);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h1.mock.calls[0][0]).toEqual(frame);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h2.mock.calls[0][0]).toEqual(frame);
  });

  it('returns false and invokes no handlers for non-bus:frame messages', () => {
    const { transport } = makeTransport();
    const h = vi.fn();
    transport.onFrame(h);

    const gitResult = transport.notifyMessage(
      createMessage('git:status', { branch: 'main' }),
      AGENT_ID
    );
    const claudeResult = transport.notifyMessage(
      createMessage('claude:start', { cwd: '/x' }),
      AGENT_ID
    );

    expect(gitResult).toBe(false);
    expect(claudeResult).toBe(false);
    expect(h).not.toHaveBeenCalled();
  });

  it('drops bus:frame messages from other agents', () => {
    const { transport } = makeTransport();
    const h = vi.fn();
    transport.onFrame(h);

    const result = transport.notifyMessage(
      createMessage('bus:frame', snapFrame()),
      'other-agent'
    );

    expect(result).toBe(false);
    expect(h).not.toHaveBeenCalled();
  });

  it('fires onFrame handlers in registration order', () => {
    const { transport } = makeTransport();
    const order: string[] = [];
    transport.onFrame(() => order.push('a'));
    transport.onFrame(() => order.push('b'));
    transport.onFrame(() => order.push('c'));

    transport.notifyMessage(createMessage('bus:frame', snapFrame()), AGENT_ID);

    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('BusClientTransport — outbound send', () => {
  it('wraps the frame in a bus:frame Message and routes via sendToAgent with the bound agentId', () => {
    const { client, transport } = makeTransport();
    const frame = subFrame();

    transport.send(frame);

    expect(client.sendToAgentCalls).toHaveLength(1);
    const { agentId, message: envelope } = client.sendToAgentCalls[0];
    expect(agentId).toBe(AGENT_ID);
    expect(envelope).toMatchObject({
      type: 'bus:frame',
      payload: frame,
    });
    expect(typeof envelope.id).toBe('string');
    expect(envelope.id.length).toBeGreaterThan(0);
    expect(typeof envelope.timestamp).toBe('number');
  });

  it('generates distinct envelope ids for successive sends', () => {
    const { client, transport } = makeTransport();

    transport.send(subFrame());
    transport.send({ kind: 'cmd', id: 'c1', verb: 'x', payload: {} });

    expect(client.sendCalls).toHaveLength(2);
    expect(client.sendCalls[0].id).not.toBe(client.sendCalls[1].id);
  });

  it('deep-equals the frame in payload', () => {
    const { client, transport } = makeTransport();
    const frame: ClientFrame = {
      kind: 'cmd',
      id: 'deep',
      verb: 'do',
      payload: { a: { b: [1, 2, { c: 'd' }] } },
    };

    transport.send(frame);

    expect(client.sendCalls[0].payload).toEqual(frame);
  });

  it('does not require the transport to be connected (bus handles gating)', () => {
    const { client, transport } = makeTransport();
    expect(transport.isConnected()).toBe(false);

    transport.send(subFrame());

    expect(client.sendCalls).toHaveLength(1);
    expect(client.sendCalls[0].type).toBe('bus:frame');
  });
});
