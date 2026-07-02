// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMessage,
  encryptWithSharedSecret,
  generateKeyPair,
  generateSessionDEK,
  serializeMessage,
  type Message,
} from '@sumicom/quicksave-shared';
import { WebSocketClient, type ConnectionEventHandler } from './websocket';

type FakeCloseEvent = { code: number; reason: string; wasClean: boolean };

const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: FakeCloseEvent) => void) | null = null;
  sent: string[] = [];
  throwOnSend = false;

  constructor(public url: string) {
    sockets.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    if (this.throwOnSend) throw new Error('send failed');
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open');
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSING;
    this.closeCode = code;
    this.closeReason = reason;
  }

  finishClose(code = this.closeCode, reason = this.closeReason): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }

  private closeCode = 1000;
  private closeReason = '';
}

class FakeBroadcastChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(public name: string) {}
  postMessage(): void {}
  close(): void {}
}

function handlers(): ConnectionEventHandler {
  return {
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onReconnecting: vi.fn(),
    onMessage: vi.fn(),
    onError: vi.fn(),
    onConnectionStep: vi.fn(),
    onAgentStatus: vi.fn(),
  };
}

function addSession(client: WebSocketClient, agentId = 'agent-1'): void {
  (client as any).sessions.set(agentId, {
    agentId,
    agentPublicKey: new Uint8Array(32),
    sessionDEK: null,
    keyExchangeComplete: false,
    keyPair: generateKeyPair(),
    keyExchangeRetries: 0,
    keyExchangeTimeout: null,
    dekPendingMessages: [],
  });
}

function completeSession(client: WebSocketClient, agentId = 'agent-1') {
  addSession(client, agentId);
  const session = (client as any).sessions.get(agentId);
  session.sessionDEK = generateSessionDEK();
  session.keyExchangeComplete = true;
  (client as any).activeAgentId = agentId;
  return session;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('WebSocketClient reconnect lifecycle', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalBroadcastChannel = globalThis.BroadcastChannel;

  beforeEach(() => {
    sockets.length = 0;
    vi.clearAllMocks();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.BroadcastChannel = FakeBroadcastChannel as unknown as typeof BroadcastChannel;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    globalThis.BroadcastChannel = originalBroadcastChannel;
  });

  it('reconnects on resume when no encrypted session can be probed', async () => {
    const h = handlers();
    const client = new WebSocketClient('ws://relay.test', 'pwa-key', h, async () => null);

    const connect = client.connect();
    sockets[0].open();
    await connect;
    addSession(client);

    client.refreshAfterResume();
    expect(h.onReconnecting).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);

    sockets[0].finishClose(4000, 'resume refresh');
    expect(h.onReconnecting).toHaveBeenCalledTimes(1);
    expect(h.onDisconnected).not.toHaveBeenCalled();

    sockets[1].open();
    await flushMicrotasks();
    expect(sockets[1].sent).toEqual([
      JSON.stringify({ type: 'watch-agent', agentId: 'agent-1' }),
    ]);
  });

  it('keeps a healthy socket when resume probe receives pong', async () => {
    vi.useFakeTimers();
    const h = handlers();
    const client = new WebSocketClient('ws://relay.test', 'pwa-key', h, async () => null);

    const connect = client.connect();
    sockets[0].open();
    await connect;
    const session = completeSession(client);
    (client as any).compress = async () => 'compressed-ping';
    (client as any).decompress = async () => serializeMessage(createMessage('pong', { timestamp: Date.now() }));

    client.refreshAfterResume();
    await flushMicrotasks();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toHaveLength(1);
    expect(h.onReconnecting).not.toHaveBeenCalled();

    const encryptedPong = encryptWithSharedSecret('compressed-pong', session.sessionDEK);
    await (client as any).handleDataMessage(encryptedPong, session);
    await vi.advanceTimersByTimeAsync(2500);

    expect(sockets).toHaveLength(1);
    expect(h.onReconnecting).not.toHaveBeenCalled();
    expect(h.onMessage).not.toHaveBeenCalled();
  });

  it('reconnects on resume probe timeout', async () => {
    vi.useFakeTimers();
    const h = handlers();
    const client = new WebSocketClient('ws://relay.test', 'pwa-key', h, async () => null);

    const connect = client.connect();
    sockets[0].open();
    await connect;
    completeSession(client);
    (client as any).compress = async () => 'compressed-ping';

    client.refreshAfterResume();
    await flushMicrotasks();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toHaveLength(1);
    expect(h.onReconnecting).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2500);

    expect(h.onReconnecting).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[0].readyState).toBe(FakeWebSocket.CLOSING);
  });

  it('queues an encrypted message and reconnects when WebSocket.send throws', async () => {
    const h = handlers();
    const client = new WebSocketClient('ws://relay.test', 'pwa-key', h, async () => null);

    const connect = client.connect();
    sockets[0].open();
    await connect;
    addSession(client);
    const session = (client as any).sessions.get('agent-1');
    session.sessionDEK = generateSessionDEK();
    session.keyExchangeComplete = true;
    sockets[0].throwOnSend = true;
    (client as any).compress = async () => 'compressed';

    const message: Message = createMessage('ping', { timestamp: Date.now() });
    client.sendToAgent('agent-1', message);
    await flushMicrotasks();

    expect(session.dekPendingMessages).toEqual([message]);
    expect(h.onReconnecting).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[0].readyState).toBe(FakeWebSocket.CLOSING);
  });
});
