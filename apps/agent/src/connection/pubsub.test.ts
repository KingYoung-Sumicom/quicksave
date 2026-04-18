import { describe, it, expect } from 'vitest';
import { PubSub, BROADCAST_TOPIC } from './pubsub.js';

describe('PubSub', () => {
  it('subscribe returns true for new, false for duplicate', () => {
    const ps = new PubSub();
    expect(ps.subscribe('peer1', 'topicA')).toBe(true);
    expect(ps.subscribe('peer1', 'topicA')).toBe(false);
  });

  it('subscribers returns all peers on a topic', () => {
    const ps = new PubSub();
    ps.subscribe('peer1', 'topicA');
    ps.subscribe('peer2', 'topicA');
    ps.subscribe('peer3', 'topicB');

    const subs = ps.subscribers('topicA');
    expect(subs.size).toBe(2);
    expect(subs.has('peer1')).toBe(true);
    expect(subs.has('peer2')).toBe(true);
    expect(subs.has('peer3')).toBe(false);
  });

  it('subscribers returns empty set for unknown topic', () => {
    const ps = new PubSub();
    expect(ps.subscribers('nonexistent').size).toBe(0);
  });

  it('unsubscribe removes peer from topic', () => {
    const ps = new PubSub();
    ps.subscribe('peer1', 'topicA');
    ps.subscribe('peer1', 'topicB');
    ps.unsubscribe('peer1', 'topicA');

    expect(ps.subscribers('topicA').has('peer1')).toBe(false);
    expect(ps.subscribers('topicB').has('peer1')).toBe(true);
  });

  it('unsubscribe cleans up empty topic sets', () => {
    const ps = new PubSub();
    ps.subscribe('peer1', 'topicA');
    ps.unsubscribe('peer1', 'topicA');

    expect(ps.hasSubscribers('topicA')).toBe(false);
  });

  it('unsubscribeAll removes peer from all topics', () => {
    const ps = new PubSub();
    ps.subscribe('peer1', 'topicA');
    ps.subscribe('peer1', 'topicB');
    ps.subscribe('peer2', 'topicA');

    const removed = ps.unsubscribeAll('peer1');
    expect(removed).toEqual(new Set(['topicA', 'topicB']));
    expect(ps.subscribers('topicA').has('peer1')).toBe(false);
    expect(ps.subscribers('topicA').has('peer2')).toBe(true);
    expect(ps.subscribers('topicB').size).toBe(0);
    expect(ps.topicsOf('peer1').size).toBe(0);
  });

  it('unsubscribeAll returns empty set for unknown peer', () => {
    const ps = new PubSub();
    expect(ps.unsubscribeAll('unknown')).toEqual(new Set());
  });

  it('topicsOf returns all topics for a peer', () => {
    const ps = new PubSub();
    ps.subscribe('peer1', 'topicA');
    ps.subscribe('peer1', 'topicB');

    const topics = ps.topicsOf('peer1');
    expect(topics.size).toBe(2);
    expect(topics.has('topicA')).toBe(true);
    expect(topics.has('topicB')).toBe(true);
  });

  it('hasSubscribers reflects current state', () => {
    const ps = new PubSub();
    expect(ps.hasSubscribers('topicA')).toBe(false);
    ps.subscribe('peer1', 'topicA');
    expect(ps.hasSubscribers('topicA')).toBe(true);
    ps.unsubscribe('peer1', 'topicA');
    expect(ps.hasSubscribers('topicA')).toBe(false);
  });

  it('multiple peers on same topic', () => {
    const ps = new PubSub();
    ps.subscribe('tab1', 'custom-topic');
    ps.subscribe('tab2', 'custom-topic');

    expect(ps.subscribers('custom-topic').size).toBe(2);
    ps.unsubscribeAll('tab1');
    expect(ps.subscribers('custom-topic').size).toBe(1);
    expect(ps.subscribers('custom-topic').has('tab2')).toBe(true);
  });

  it('peer subscribed to custom topic + broadcast', () => {
    const ps = new PubSub();
    ps.subscribe('peer1', BROADCAST_TOPIC);
    ps.subscribe('peer1', 'custom-topic');

    expect(ps.topicsOf('peer1').size).toBe(2);
    ps.unsubscribe('peer1', 'custom-topic');
    expect(ps.topicsOf('peer1').size).toBe(1);
    expect(ps.subscribers(BROADCAST_TOPIC).has('peer1')).toBe(true);
  });
});
