import type { ClientTransport } from './transport.js';
import type { CommandResultFrame, ServerFrame } from './types.js';

export type SubscribeCallbacks<S = unknown, U = unknown> = {
  onSnapshot: (data: S) => void;
  onUpdate: (data: U) => void;
  onError?: (error: string) => void;
};

type PendingCommand = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type SubscriptionState = {
  path: string;
  refcount: number;
  subscribers: Set<SubscribeCallbacks>;
  lastSnapshot?: { data: unknown };
  /**
   * True once we've sent a sub frame and expect server delivery.
   * Re-sent on reconnect.
   */
  wireActive: boolean;
};

export type CommandOptions = {
  /** Timeout in ms. 0 or undefined disables. */
  timeoutMs?: number;
  /**
   * If the transport is disconnected when command is issued, queue until
   * reconnect. Default: false (reject immediately).
   */
  queueWhileDisconnected?: boolean;
};

let idCounter = 0;
function nextId(): string {
  idCounter = (idCounter + 1) | 0;
  return `c${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export class MessageBusClient {
  private pending = new Map<string, PendingCommand>();
  private subs = new Map<string, SubscriptionState>();
  private queue: Array<() => void> = [];

  constructor(private transport: ClientTransport) {
    transport.onFrame((frame) => this.handleFrame(frame));
    transport.onConnected(() => this.handleConnected());
    transport.onDisconnected(() => this.handleDisconnected());
  }

  /**
   * Issue a one-shot command. Resolves with the server's response data,
   * rejects with the server's error string or a timeout.
   */
  command<R = unknown, P = unknown>(
    verb: string,
    payload: P,
    opts: CommandOptions = {},
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const id = nextId();
      const pending: PendingCommand = {
        resolve: (data) => resolve(data as R),
        reject,
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`Command "${verb}" timed out after ${opts.timeoutMs}ms`));
          }
        }, opts.timeoutMs);
      }
      this.pending.set(id, pending);
      const send = () => {
        this.transport.send({ kind: 'cmd', id, verb, payload });
      };
      if (this.transport.isConnected()) {
        send();
      } else if (opts.queueWhileDisconnected) {
        this.queue.push(send);
      } else {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(new Error(`Transport is disconnected; cannot send "${verb}"`));
      }
    });
  }

  /**
   * Subscribe to a path. If another subscriber is already attached, the new
   * callbacks immediately receive the last snapshot (if any) without a
   * wire-level resubscribe; refcount is incremented.
   *
   * Returns an unsubscribe function. On the last unsubscribe for a path, an
   * `unsub` frame is sent.
   */
  subscribe<S = unknown, U = unknown>(
    path: string,
    callbacks: SubscribeCallbacks<S, U>,
  ): () => void {
    const cb = callbacks as SubscribeCallbacks;
    let state = this.subs.get(path);
    if (!state) {
      state = {
        path,
        refcount: 0,
        subscribers: new Set(),
        wireActive: false,
      };
      this.subs.set(path, state);
    }
    state.subscribers.add(cb);
    state.refcount++;
    // If we already have a cached snapshot, replay it to the new subscriber.
    if (state.lastSnapshot) {
      queueMicrotask(() => {
        if (state.subscribers.has(cb)) cb.onSnapshot(state.lastSnapshot!.data);
      });
    }
    // Ensure a wire-level subscription exists.
    if (!state.wireActive) {
      const send = () => {
        if (!this.subs.get(path)) return;
        this.transport.send({ kind: 'sub', path });
        state.wireActive = true;
      };
      if (this.transport.isConnected()) send();
      else this.queue.push(send);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.subs.get(path);
      if (!current) return;
      current.subscribers.delete(cb);
      current.refcount = Math.max(0, current.refcount - 1);
      if (current.refcount === 0) {
        this.subs.delete(path);
        if (current.wireActive && this.transport.isConnected()) {
          this.transport.send({ kind: 'unsub', path });
        }
      }
    };
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame.kind) {
      case 'result':
        this.handleResult(frame);
        return;
      case 'snap':
        this.handleSnapshot(frame.path, frame.data);
        return;
      case 'upd':
        this.handleUpdate(frame.path, frame.data);
        return;
      case 'sub-error':
        this.handleSubError(frame.path, frame.error);
        return;
    }
  }

  private handleResult(frame: CommandResultFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (frame.ok) pending.resolve(frame.data);
    else pending.reject(new Error(frame.error));
  }

  private handleSnapshot(path: string, data: unknown): void {
    const state = this.subs.get(path);
    if (!state) return;
    state.lastSnapshot = { data };
    for (const cb of state.subscribers) cb.onSnapshot(data);
  }

  private handleUpdate(path: string, data: unknown): void {
    const state = this.subs.get(path);
    if (!state) return;
    state.lastSnapshot = { data };
    for (const cb of state.subscribers) cb.onUpdate(data);
  }

  private handleSubError(path: string, error: string): void {
    const state = this.subs.get(path);
    if (!state) return;
    for (const cb of state.subscribers) cb.onError?.(error);
  }

  private handleConnected(): void {
    // Flush any queued sends (commands issued while disconnected).
    const pending = this.queue;
    this.queue = [];
    for (const fn of pending) fn();
    // Re-establish wire subscriptions.
    for (const state of this.subs.values()) {
      this.transport.send({ kind: 'sub', path: state.path });
      state.wireActive = true;
    }
  }

  private handleDisconnected(): void {
    for (const state of this.subs.values()) {
      state.wireActive = false;
    }
    // Reject all in-flight commands. They were sent to a peer that's no
    // longer reachable; waiting for their timeout would surface misleading
    // "timed out after Nms" errors to the caller. The caller can retry
    // after reconnect if needed.
    if (this.pending.size > 0) {
      const stranded = Array.from(this.pending.values());
      this.pending.clear();
      for (const p of stranded) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error('Transport disconnected before response'));
      }
    }
  }
}
