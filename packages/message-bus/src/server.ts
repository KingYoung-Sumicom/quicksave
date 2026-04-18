import {
  matchPattern,
  parsePattern,
  sortPatternsBySpecificity,
  type PathPattern,
} from './path.js';
import type { ServerTransport, PeerId } from './transport.js';
import type { ClientFrame, PathParams } from './types.js';

export type CommandHandler<P = unknown, R = unknown> = (
  payload: P,
  ctx: { peer: PeerId },
) => Promise<R> | R;

export type SubscribeHandler<
  Path extends string = string,
  S = unknown,
  // U is used by the returned Publisher via publish<U>(); it narrows the
  // publish call site for users who pass a typed pattern. We do not hold
  // a runtime reference to U, so the parameter is intentionally unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _U = unknown,
> = {
  snapshot: (ctx: {
    path: string;
    params: PathParams<Path>;
    peer: PeerId;
  }) => Promise<S> | S;
  onSubscribed?: (ctx: {
    path: string;
    params: PathParams<Path>;
    peer: PeerId;
  }) => void;
  onUnsubscribed?: (ctx: {
    path: string;
    params: PathParams<Path>;
    peer: PeerId;
  }) => void;
};

type SubscriptionEntry = {
  pattern: PathPattern;
  handler: SubscribeHandler<string, unknown, unknown>;
};

type ActiveSub = {
  peer: PeerId;
  path: string;
  pattern: PathPattern;
  params: Record<string, string>;
};

export class MessageBusServer {
  private commands = new Map<string, CommandHandler>();
  private subscriptions: SubscriptionEntry[] = [];
  private active = new Map<string, ActiveSub>();
  private byPeer = new Map<PeerId, Set<string>>();

  constructor(private transport: ServerTransport) {
    transport.onFrame((peer, frame) => this.handleFrame(peer, frame));
    transport.onPeerDisconnected((peer) => this.handlePeerDisconnected(peer));
  }

  onCommand<P = unknown, R = unknown>(
    verb: string,
    handler: CommandHandler<P, R>,
  ): void {
    if (this.commands.has(verb)) {
      throw new Error(`Command "${verb}" is already registered`);
    }
    this.commands.set(verb, handler as CommandHandler);
  }

  onSubscribe<Path extends string, S = unknown, U = unknown>(
    pattern: Path,
    handler: SubscribeHandler<Path, S, U>,
  ): void {
    const parsed = parsePattern(pattern);
    if (this.subscriptions.some((e) => e.pattern.pattern === parsed.pattern)) {
      throw new Error(`Subscription pattern "${pattern}" is already registered`);
    }
    this.subscriptions.push({
      pattern: parsed,
      handler: handler as SubscribeHandler<string, unknown, unknown>,
    });
    sortPatternsBySpecificity(this.subscriptions);
  }

  /**
   * Broadcast an update to every peer currently subscribed to `path`.
   * Returns the number of peers that received the update.
   */
  publish<U = unknown>(path: string, data: U): number {
    let count = 0;
    for (const sub of this.active.values()) {
      if (sub.path === path) {
        this.transport.send(sub.peer, { kind: 'upd', path, data });
        count++;
      }
    }
    return count;
  }

  /** Number of peers currently subscribed to the exact `path`. */
  subscriberCount(path: string): number {
    let count = 0;
    for (const sub of this.active.values()) {
      if (sub.path === path) count++;
    }
    return count;
  }

  private handleFrame(peer: PeerId, frame: ClientFrame): void {
    switch (frame.kind) {
      case 'cmd':
        void this.handleCommand(peer, frame.id, frame.verb, frame.payload);
        return;
      case 'sub':
        void this.handleSubscribe(peer, frame.path);
        return;
      case 'unsub':
        this.handleUnsubscribe(peer, frame.path);
        return;
    }
  }

  private async handleCommand(
    peer: PeerId,
    id: string,
    verb: string,
    payload: unknown,
  ): Promise<void> {
    const handler = this.commands.get(verb);
    if (!handler) {
      this.transport.send(peer, {
        kind: 'result',
        id,
        ok: false,
        error: `Unknown command: ${verb}`,
      });
      return;
    }
    try {
      const data = await handler(payload, { peer });
      this.transport.send(peer, { kind: 'result', id, ok: true, data });
    } catch (err) {
      this.transport.send(peer, {
        kind: 'result',
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleSubscribe(peer: PeerId, path: string): Promise<void> {
    const key = subKey(peer, path);
    if (this.active.has(key)) {
      // Duplicate subscribe from same peer — client layer dedups, but be
      // defensive on the wire. Re-send snapshot using existing handler.
      const existing = this.active.get(key)!;
      await this.sendSnapshot(peer, existing);
      return;
    }
    const matched = this.findMatch(path);
    if (!matched) {
      this.transport.send(peer, {
        kind: 'sub-error',
        path,
        error: `No subscription handler for path: ${path}`,
      });
      return;
    }
    const entry: ActiveSub = {
      peer,
      path,
      pattern: matched.entry.pattern,
      params: matched.params,
    };
    this.active.set(key, entry);
    let peerSet = this.byPeer.get(peer);
    if (!peerSet) {
      peerSet = new Set();
      this.byPeer.set(peer, peerSet);
    }
    peerSet.add(key);
    try {
      await this.sendSnapshot(peer, entry);
    } catch (err) {
      this.active.delete(key);
      peerSet.delete(key);
      this.transport.send(peer, {
        kind: 'sub-error',
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    matched.entry.handler.onSubscribed?.({
      path,
      params: entry.params as PathParams<string>,
      peer,
    });
  }

  private async sendSnapshot(peer: PeerId, entry: ActiveSub): Promise<void> {
    const handler = this.subscriptions.find(
      (e) => e.pattern.pattern === entry.pattern.pattern,
    )?.handler;
    if (!handler) {
      throw new Error(
        `Subscription pattern "${entry.pattern.pattern}" is no longer registered`,
      );
    }
    const data = await handler.snapshot({
      path: entry.path,
      params: entry.params as PathParams<string>,
      peer,
    });
    this.transport.send(peer, { kind: 'snap', path: entry.path, data });
  }

  private handleUnsubscribe(peer: PeerId, path: string): void {
    const key = subKey(peer, path);
    const entry = this.active.get(key);
    if (!entry) return;
    this.active.delete(key);
    this.byPeer.get(peer)?.delete(key);
    const handler = this.subscriptions.find(
      (e) => e.pattern.pattern === entry.pattern.pattern,
    )?.handler;
    handler?.onUnsubscribed?.({
      path: entry.path,
      params: entry.params as PathParams<string>,
      peer,
    });
  }

  private handlePeerDisconnected(peer: PeerId): void {
    const keys = this.byPeer.get(peer);
    if (!keys) return;
    for (const key of keys) {
      const entry = this.active.get(key);
      if (!entry) continue;
      this.active.delete(key);
      const handler = this.subscriptions.find(
        (e) => e.pattern.pattern === entry.pattern.pattern,
      )?.handler;
      handler?.onUnsubscribed?.({
        path: entry.path,
        params: entry.params as PathParams<string>,
        peer,
      });
    }
    this.byPeer.delete(peer);
  }

  private findMatch(
    path: string,
  ): { entry: SubscriptionEntry; params: Record<string, string> } | null {
    for (const entry of this.subscriptions) {
      const params = matchPattern(entry.pattern, path);
      if (params) return { entry, params };
    }
    return null;
  }
}

function subKey(peer: PeerId, path: string): string {
  return `${peer}\u0000${path}`;
}
