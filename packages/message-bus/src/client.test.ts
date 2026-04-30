// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBusClient } from './client.js';
import type { ClientTransport } from './transport.js';
import type { ClientFrame, ServerFrame } from './types.js';

class StubClientTransport implements ClientTransport {
  sent: ClientFrame[] = [];
  private frameHandler?: (frame: ServerFrame) => void;
  private connectHandler?: () => void;
  private disconnectHandler?: () => void;
  private reestablishedHandler?: () => void;
  private connected = true;

  send(frame: ClientFrame): void {
    this.sent.push(frame);
  }
  onFrame(handler: (frame: ServerFrame) => void): void {
    this.frameHandler = handler;
  }
  onConnected(handler: () => void): void {
    this.connectHandler = handler;
  }
  onDisconnected(handler: () => void): void {
    this.disconnectHandler = handler;
  }
  onReestablished(handler: () => void): void {
    this.reestablishedHandler = handler;
  }
  isConnected(): boolean {
    return this.connected;
  }
  setConnected(value: boolean): void {
    this.connected = value;
    if (value) {
      this.connectHandler?.();
      // Mirror real transports: every fresh upstream session fires
      // reestablished alongside the connected transition.
      this.reestablishedHandler?.();
    } else {
      this.disconnectHandler?.();
    }
  }
  /** Fire onReestablished without changing connected state (blip recovery). */
  fireReestablished(): void {
    this.reestablishedHandler?.();
  }
  emit(frame: ServerFrame): void {
    this.frameHandler?.(frame);
  }
  clear(): void {
    this.sent = [];
  }
}

describe('MessageBusClient - commands', () => {
  let transport: StubClientTransport;
  let client: MessageBusClient;

  beforeEach(() => {
    transport = new StubClientTransport();
    client = new MessageBusClient(transport);
  });

  it('sends a command and resolves on success', async () => {
    const promise = client.command<number>('add', { a: 1, b: 2 });
    expect(transport.sent).toHaveLength(1);
    const sent = transport.sent[0]!;
    expect(sent.kind).toBe('cmd');
    const id = (sent as { id: string }).id;
    transport.emit({ kind: 'result', id, ok: true, data: 3 });
    await expect(promise).resolves.toBe(3);
  });

  it('rejects on error result', async () => {
    const promise = client.command('fail', null);
    const id = (transport.sent[0] as { id: string }).id;
    transport.emit({ kind: 'result', id, ok: false, error: 'nope' });
    await expect(promise).rejects.toThrow('nope');
  });

  it('rejects with timeout', async () => {
    vi.useFakeTimers();
    try {
      const promise = client.command('slow', null, { timeoutMs: 100 });
      vi.advanceTimersByTime(100);
      await expect(promise).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects immediately when disconnected by default', async () => {
    transport.setConnected(false);
    await expect(client.command('x', null)).rejects.toThrow(/disconnected/);
  });

  it('queues when disconnected with queueWhileDisconnected', async () => {
    transport.setConnected(false);
    transport.clear();
    const promise = client.command<number>('add', null, {
      queueWhileDisconnected: true,
    });
    expect(transport.sent).toHaveLength(0);
    transport.setConnected(true);
    expect(transport.sent).toHaveLength(1);
    const id = (transport.sent[0] as { id: string }).id;
    transport.emit({ kind: 'result', id, ok: true, data: 42 });
    await expect(promise).resolves.toBe(42);
  });

  it('rejects in-flight commands when transport disconnects', async () => {
    const promise = client.command<number>('slow', null, { timeoutMs: 60_000 });
    expect(transport.sent).toHaveLength(1);
    transport.setConnected(false);
    await expect(promise).rejects.toThrow(/disconnected/i);
  });

  it('does not fire timeout timer for commands stranded by disconnect', async () => {
    vi.useFakeTimers();
    try {
      const promise = client.command('slow', null, { timeoutMs: 100 });
      transport.setConnected(false);
      const settled = promise.catch((e) => e);
      // The disconnect-rejection path must clear the timer so advancing past
      // the timeout doesn't produce a second, misleading rejection.
      vi.advanceTimersByTime(1_000);
      const err = await settled;
      expect(String(err)).toMatch(/disconnected/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MessageBusClient - subscriptions', () => {
  let transport: StubClientTransport;
  let client: MessageBusClient;

  beforeEach(() => {
    transport = new StubClientTransport();
    client = new MessageBusClient(transport);
  });

  it('sends sub frame and delivers snapshot then update', () => {
    const onSnapshot = vi.fn();
    const onUpdate = vi.fn();
    client.subscribe('/x/1', { onSnapshot, onUpdate });
    expect(transport.sent[0]).toEqual({ kind: 'sub', path: '/x/1' });
    transport.emit({ kind: 'snap', path: '/x/1', data: 's' });
    transport.emit({ kind: 'upd', path: '/x/1', data: 'u' });
    expect(onSnapshot).toHaveBeenCalledWith('s');
    expect(onUpdate).toHaveBeenCalledWith('u');
  });

  it('dedups on client: second subscriber reuses wire sub and replays cached snapshot', async () => {
    const onSnapshot1 = vi.fn();
    const onUpdate1 = vi.fn();
    client.subscribe('/x/1', { onSnapshot: onSnapshot1, onUpdate: onUpdate1 });
    expect(transport.sent).toHaveLength(1);
    transport.emit({ kind: 'snap', path: '/x/1', data: 's' });

    const onSnapshot2 = vi.fn();
    const onUpdate2 = vi.fn();
    client.subscribe('/x/1', { onSnapshot: onSnapshot2, onUpdate: onUpdate2 });
    // No additional wire sub
    expect(transport.sent).toHaveLength(1);
    // Replay via microtask
    await Promise.resolve();
    expect(onSnapshot2).toHaveBeenCalledWith('s');

    // Both receive subsequent updates
    transport.emit({ kind: 'upd', path: '/x/1', data: 'u' });
    expect(onUpdate1).toHaveBeenCalledWith('u');
    expect(onUpdate2).toHaveBeenCalledWith('u');
  });

  it('only sends unsub after last subscriber releases', () => {
    const off1 = client.subscribe('/x/1', {
      onSnapshot: vi.fn(),
      onUpdate: vi.fn(),
    });
    const off2 = client.subscribe('/x/1', {
      onSnapshot: vi.fn(),
      onUpdate: vi.fn(),
    });
    transport.clear();
    off1();
    expect(transport.sent).toHaveLength(0);
    off2();
    expect(transport.sent).toEqual([{ kind: 'unsub', path: '/x/1' }]);
  });

  it('is idempotent on double unsub', () => {
    const off = client.subscribe('/x/1', {
      onSnapshot: vi.fn(),
      onUpdate: vi.fn(),
    });
    transport.clear();
    off();
    off();
    expect(transport.sent).toEqual([{ kind: 'unsub', path: '/x/1' }]);
  });

  it('re-subscribes after reconnect', () => {
    client.subscribe('/x/1', { onSnapshot: vi.fn(), onUpdate: vi.fn() });
    transport.clear();
    transport.setConnected(false);
    transport.setConnected(true);
    expect(transport.sent).toEqual([{ kind: 'sub', path: '/x/1' }]);
  });

  it('re-subscribes on reestablish even when the transport never transitioned to disconnected', () => {
    // Mirrors the prod PWA scenario: the WebSocket layer suppresses the
    // per-agent disconnect during a brief blip (to keep streaming UI alive),
    // but the agent still wipes the peer's subs on its end. The bus must
    // re-send sub frames when notifyReestablished fires, even though
    // transport.isConnected stayed true the whole time.
    client.subscribe('/x/1', { onSnapshot: vi.fn(), onUpdate: vi.fn() });
    transport.clear();
    expect(transport.isConnected()).toBe(true);
    transport.fireReestablished();
    expect(transport.sent).toEqual([{ kind: 'sub', path: '/x/1' }]);
  });

  it('forwards sub-error to subscriber onError', () => {
    const onError = vi.fn();
    client.subscribe('/x/1', {
      onSnapshot: vi.fn(),
      onUpdate: vi.fn(),
      onError,
    });
    transport.emit({ kind: 'sub-error', path: '/x/1', error: 'nope' });
    expect(onError).toHaveBeenCalledWith('nope');
  });

  it('stops delivering to a released subscriber', () => {
    const onUpdate1 = vi.fn();
    const onUpdate2 = vi.fn();
    const off1 = client.subscribe('/x/1', {
      onSnapshot: vi.fn(),
      onUpdate: onUpdate1,
    });
    client.subscribe('/x/1', { onSnapshot: vi.fn(), onUpdate: onUpdate2 });
    off1();
    transport.emit({ kind: 'upd', path: '/x/1', data: 'u' });
    expect(onUpdate1).not.toHaveBeenCalled();
    expect(onUpdate2).toHaveBeenCalledWith('u');
  });
});

describe('MessageBusClient - seq ordering', () => {
  let transport: StubClientTransport;
  let client: MessageBusClient;

  beforeEach(() => {
    transport = new StubClientTransport();
    client = new MessageBusClient(transport);
  });

  it('drops a raced stale snapshot whose seq is older than an already-applied update', () => {
    // Scenario: server sub handler is awaiting snapshot data when a publish
    // fires. The publish's `upd` (seq 5) reaches the wire first, then the
    // snapshot (seq 4, captured before the publish). Without seq the snap
    // would overwrite newer state on the client.
    const onSnapshot = vi.fn();
    const onUpdate = vi.fn();
    client.subscribe('/x/1', { onSnapshot, onUpdate });
    transport.emit({ kind: 'upd', path: '/x/1', data: 'new', seq: 5 });
    transport.emit({ kind: 'snap', path: '/x/1', data: 'old', seq: 4 });
    expect(onUpdate).toHaveBeenCalledWith('new');
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('applies a snapshot whose seq equals the already-applied update (boundary case)', () => {
    // Natural server traffic won't produce this — snapshot seq is captured
    // before the handler, so a raced publish always has a strictly greater
    // seq. But the client's drop rule uses `<` for snapshots (not `<=`) so
    // that onSnapshot still fires when the server emits a matching seq.
    const onSnapshot = vi.fn();
    const onUpdate = vi.fn();
    client.subscribe('/x/1', { onSnapshot, onUpdate });
    transport.emit({ kind: 'upd', path: '/x/1', data: 'v', seq: 5 });
    transport.emit({ kind: 'snap', path: '/x/1', data: 'v', seq: 5 });
    expect(onUpdate).toHaveBeenCalledWith('v');
    expect(onSnapshot).toHaveBeenCalledWith('v');
  });

  it('drops duplicate updates at the same seq', () => {
    const onUpdate = vi.fn();
    client.subscribe('/x/1', { onSnapshot: vi.fn(), onUpdate });
    transport.emit({ kind: 'snap', path: '/x/1', data: 's', seq: 1 });
    transport.emit({ kind: 'upd', path: '/x/1', data: 'u', seq: 1 });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('applies updates in increasing seq order', () => {
    const onUpdate = vi.fn();
    client.subscribe('/x/1', { onSnapshot: vi.fn(), onUpdate });
    transport.emit({ kind: 'snap', path: '/x/1', data: 's', seq: 1 });
    transport.emit({ kind: 'upd', path: '/x/1', data: 'a', seq: 2 });
    transport.emit({ kind: 'upd', path: '/x/1', data: 'b', seq: 3 });
    expect(onUpdate).toHaveBeenNthCalledWith(1, 'a');
    expect(onUpdate).toHaveBeenNthCalledWith(2, 'b');
  });

  it('applies frames unconditionally when seq is absent (legacy-server fallback)', () => {
    const onSnapshot = vi.fn();
    const onUpdate = vi.fn();
    client.subscribe('/x/1', { onSnapshot, onUpdate });
    // No `seq` field on either frame — should behave as before (apply both).
    transport.emit({ kind: 'upd', path: '/x/1', data: 'u' });
    transport.emit({ kind: 'snap', path: '/x/1', data: 's' });
    expect(onUpdate).toHaveBeenCalledWith('u');
    expect(onSnapshot).toHaveBeenCalledWith('s');
  });

  it('resets lastSeq on reconnect so a server restart is not mistaken for stale frames', () => {
    const onSnapshot = vi.fn();
    const onUpdate = vi.fn();
    client.subscribe('/x/1', { onSnapshot, onUpdate });
    transport.emit({ kind: 'snap', path: '/x/1', data: 's1', seq: 10 });
    expect(onSnapshot).toHaveBeenCalledWith('s1');

    // Connection drops; on reconnect server restarted with fresh counter.
    transport.setConnected(false);
    transport.setConnected(true);
    transport.emit({ kind: 'snap', path: '/x/1', data: 's2', seq: 1 });
    // Without the reset, seq 1 < 10 would incorrectly drop this snapshot.
    expect(onSnapshot).toHaveBeenCalledWith('s2');
  });
});
