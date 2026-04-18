/**
 * Topic-based pub/sub with reverse index for efficient peer cleanup.
 *
 * Only topic left after the MessageBus migration:
 *   "broadcast" — legacy wide broadcast channel (peers auto-subscribe on key exchange).
 *
 * Session-scoped state (cards, stream-end, pending input) now flows through
 * the MessageBus `/sessions/:sessionId/cards` subscription instead.
 */
export class PubSub {
  /** topic → Set<peerAddress> */
  private topics = new Map<string, Set<string>>();
  /** peerAddress → Set<topic> (reverse index for O(topics) cleanup) */
  private peerTopics = new Map<string, Set<string>>();

  /**
   * Subscribe a peer to a topic.
   * Returns true if this is a NEW subscription.
   */
  subscribe(peer: string, topic: string): boolean {
    let subscribers = this.topics.get(topic);
    if (!subscribers) {
      subscribers = new Set();
      this.topics.set(topic, subscribers);
    }
    const isNew = !subscribers.has(peer);
    subscribers.add(peer);

    let topics = this.peerTopics.get(peer);
    if (!topics) {
      topics = new Set();
      this.peerTopics.set(peer, topics);
    }
    topics.add(topic);

    return isNew;
  }

  /** Unsubscribe a peer from a specific topic. */
  unsubscribe(peer: string, topic: string): void {
    const subscribers = this.topics.get(topic);
    if (subscribers) {
      subscribers.delete(peer);
      if (subscribers.size === 0) this.topics.delete(topic);
    }
    const topics = this.peerTopics.get(peer);
    if (topics) {
      topics.delete(topic);
      if (topics.size === 0) this.peerTopics.delete(peer);
    }
  }

  /**
   * Unsubscribe a peer from ALL topics. Called on disconnect.
   * Returns the set of topics the peer was subscribed to.
   */
  unsubscribeAll(peer: string): Set<string> {
    const topics = this.peerTopics.get(peer);
    if (!topics) return new Set();

    const removed = new Set(topics);
    for (const topic of topics) {
      const subscribers = this.topics.get(topic);
      if (subscribers) {
        subscribers.delete(peer);
        if (subscribers.size === 0) this.topics.delete(topic);
      }
    }
    this.peerTopics.delete(peer);
    return removed;
  }

  /** Get all peers subscribed to a topic. */
  subscribers(topic: string): ReadonlySet<string> {
    return this.topics.get(topic) ?? EMPTY_SET;
  }

  /** Get all topics a peer is subscribed to. */
  topicsOf(peer: string): ReadonlySet<string> {
    return this.peerTopics.get(peer) ?? EMPTY_SET;
  }

  /** Check if a topic has any subscribers. */
  hasSubscribers(topic: string): boolean {
    const subs = this.topics.get(topic);
    return !!subs && subs.size > 0;
  }

  /** Snapshot of all subscriptions for debugging. */
  getState(): { topics: Record<string, string[]>; peerTopics: Record<string, string[]> } {
    const topics: Record<string, string[]> = {};
    for (const [topic, peers] of this.topics) {
      topics[topic] = [...peers];
    }
    const peerTopics: Record<string, string[]> = {};
    for (const [peer, t] of this.peerTopics) {
      peerTopics[peer] = [...t];
    }
    return { topics, peerTopics };
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** The broadcast topic — all connected peers auto-subscribe. */
export const BROADCAST_TOPIC = 'broadcast';
