// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMessage,
  generateKeyPair,
  generateSessionDEK,
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
    globalThis.WebSocket = originalWebSocket;
    globalThis.BroadcastChannel = originalBroadcastChannel;
  });

  it('suppresses the stale socket close produced by refreshAfterResume', async () => {
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
