// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { attachSessionAttention, type AttentionDeps } from './useSessionAttention';

type Handler = () => void;
type ListenerKey = `${'document' | 'window'}:${string}`;

interface FakeEnv {
  deps: AttentionDeps;
  setAttending: (v: boolean) => void;
  fire: (target: 'document' | 'window', event: string) => void;
  listenerCount: () => number;
}

function makeEnv(initial = true, onAttendChange?: AttentionDeps['onAttendChange']): FakeEnv {
  let attending = initial;
  const listeners = new Map<ListenerKey, Set<Handler>>();
  const key = (t: 'document' | 'window', e: string) => `${t}:${e}` as ListenerKey;
  return {
    deps: {
      isAttending: () => attending,
      addListener: (t, e, h) => {
        const k = key(t, e);
        let set = listeners.get(k);
        if (!set) { set = new Set(); listeners.set(k, set); }
        set.add(h);
      },
      removeListener: (t, e, h) => {
        const k = key(t, e);
        listeners.get(k)?.delete(h);
      },
      onAttendChange,
    },
    setAttending: (v) => { attending = v; },
    fire: (t, e) => {
      const set = listeners.get(key(t, e));
      if (!set) return;
      for (const h of [...set]) h();
    },
    listenerCount: () => {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

function makeBus() {
  const subscribe = vi.fn();
  const unsub = vi.fn();
  subscribe.mockImplementation(() => unsub);
  return {
    bus: { subscribe } as unknown as MessageBusClient,
    subscribe,
    unsub,
  };
}

describe('attachSessionAttention', () => {
  beforeEach(() => vi.clearAllMocks());

  it('subscribes immediately when already attending', () => {
    const env = makeEnv(true);
    const { bus, subscribe } = makeBus();
    attachSessionAttention('s1', () => bus, env.deps);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0][0]).toBe('/sessions/s1/attention');
  });

  it('does not subscribe when not attending (starts hidden)', () => {
    const env = makeEnv(false);
    const { bus, subscribe } = makeBus();
    attachSessionAttention('s1', () => bus, env.deps);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('subscribes on visibility → visible and unsubscribes on hidden', () => {
    const env = makeEnv(false);
    const { bus, subscribe, unsub } = makeBus();
    attachSessionAttention('s1', () => bus, env.deps);

    // Tab becomes visible+focused.
    env.setAttending(true);
    env.fire('document', 'visibilitychange');
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsub).not.toHaveBeenCalled();

    // Tab goes hidden.
    env.setAttending(false);
    env.fire('document', 'visibilitychange');
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('sync is idempotent — no duplicate subscribe when already attending', () => {
    const env = makeEnv(true);
    const { bus, subscribe } = makeBus();
    attachSessionAttention('s1', () => bus, env.deps);

    env.fire('window', 'focus');
    env.fire('document', 'visibilitychange');
    env.fire('window', 'focus');
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('focus/blur drive subscribe state independently of visibility', () => {
    const env = makeEnv(true);
    const { bus, subscribe, unsub } = makeBus();
    attachSessionAttention('s1', () => bus, env.deps);
    expect(subscribe).toHaveBeenCalledTimes(1);

    // Window loses focus → attending becomes false.
    env.setAttending(false);
    env.fire('window', 'blur');
    expect(unsub).toHaveBeenCalledTimes(1);

    // Regains focus.
    env.setAttending(true);
    env.fire('window', 'focus');
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('pagehide releases the subscription even if visibility stays "visible"', () => {
    // Models iOS PWA going to Home Screen, where pagehide can fire without
    // a matching visibilitychange beforehand.
    const env = makeEnv(true);
    const { bus, unsub } = makeBus();
    attachSessionAttention('s1', () => bus, env.deps);

    env.fire('window', 'pagehide');
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('re-subscribes on pageshow after an iOS-style pagehide', () => {
    const env = makeEnv(true);
    const { bus, subscribe, unsub } = makeBus();
    attachSessionAttention('s1', () => bus, env.deps);

    env.fire('window', 'pagehide');
    expect(unsub).toHaveBeenCalledTimes(1);

    env.setAttending(true);
    env.fire('window', 'pageshow');
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('disposer removes every listener and releases the subscription', () => {
    const env = makeEnv(true);
    const { bus, unsub } = makeBus();
    const dispose = attachSessionAttention('s1', () => bus, env.deps);
    expect(env.listenerCount()).toBeGreaterThan(0);

    dispose();
    expect(env.listenerCount()).toBe(0);
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('does not crash if bus is unavailable at sync time — retries on next sync', () => {
    const env = makeEnv(true);
    let bus: MessageBusClient | null = null;
    const { bus: realBus, subscribe } = makeBus();

    attachSessionAttention('s1', () => bus, env.deps);
    expect(subscribe).not.toHaveBeenCalled();

    // Bus becomes available later (e.g. after handshake) — next sync attaches.
    bus = realBus;
    env.fire('document', 'visibilitychange');
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('does not double-unsubscribe when pagehide fires after visibility=hidden', () => {
    const env = makeEnv(true);
    const { bus, unsub } = makeBus();
    attachSessionAttention('s1', () => bus, env.deps);

    env.setAttending(false);
    env.fire('document', 'visibilitychange');
    env.fire('window', 'pagehide');
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('scopes path to the supplied sessionId', () => {
    const env = makeEnv(true);
    const { bus, subscribe } = makeBus();
    attachSessionAttention('abc-123', () => bus, env.deps);
    expect(subscribe.mock.calls[0][0]).toBe('/sessions/abc-123/attention');
  });

  // ── onAttendChange ────────────────────────────────────────────────────

  describe('onAttendChange callback', () => {
    it('fires (sessionId, true) on initial mount when already attending', () => {
      const onAttendChange = vi.fn();
      const env = makeEnv(true, onAttendChange);
      const { bus } = makeBus();
      attachSessionAttention('s1', () => bus, env.deps);
      expect(onAttendChange).toHaveBeenCalledTimes(1);
      expect(onAttendChange).toHaveBeenCalledWith('s1', true);
    });

    it('does NOT fire on initial mount when not attending', () => {
      const onAttendChange = vi.fn();
      const env = makeEnv(false, onAttendChange);
      const { bus } = makeBus();
      attachSessionAttention('s1', () => bus, env.deps);
      expect(onAttendChange).not.toHaveBeenCalled();
    });

    it('fires once per real transition (visibility false → true → false)', () => {
      const onAttendChange = vi.fn();
      const env = makeEnv(false, onAttendChange);
      const { bus } = makeBus();
      attachSessionAttention('s1', () => bus, env.deps);

      env.setAttending(true);
      env.fire('document', 'visibilitychange');
      env.setAttending(false);
      env.fire('document', 'visibilitychange');

      expect(onAttendChange).toHaveBeenCalledTimes(2);
      expect(onAttendChange).toHaveBeenNthCalledWith(1, 's1', true);
      expect(onAttendChange).toHaveBeenNthCalledWith(2, 's1', false);
    });

    it('does not double-fire when the same isAttending value is reported repeatedly', () => {
      const onAttendChange = vi.fn();
      const env = makeEnv(true, onAttendChange);
      const { bus } = makeBus();
      attachSessionAttention('s1', () => bus, env.deps);

      // Several focus events while still focused — no transitions.
      env.fire('window', 'focus');
      env.fire('document', 'visibilitychange');
      env.fire('window', 'focus');

      expect(onAttendChange).toHaveBeenCalledTimes(1);
    });

    it('fires (sessionId, false) on pagehide when previously attending', () => {
      const onAttendChange = vi.fn();
      const env = makeEnv(true, onAttendChange);
      const { bus } = makeBus();
      attachSessionAttention('s1', () => bus, env.deps);
      expect(onAttendChange).toHaveBeenCalledTimes(1);

      env.fire('window', 'pagehide');
      expect(onAttendChange).toHaveBeenCalledTimes(2);
      expect(onAttendChange).toHaveBeenLastCalledWith('s1', false);
    });

    it('fires (sessionId, true) on pageshow after pagehide detached attention', () => {
      const onAttendChange = vi.fn();
      const env = makeEnv(true, onAttendChange);
      const { bus } = makeBus();
      attachSessionAttention('s1', () => bus, env.deps);
      env.fire('window', 'pagehide');
      onAttendChange.mockClear();

      env.setAttending(true);
      env.fire('window', 'pageshow');

      expect(onAttendChange).toHaveBeenCalledTimes(1);
      expect(onAttendChange).toHaveBeenCalledWith('s1', true);
    });

    it('does not fire pagehide when already detached (no transition)', () => {
      const onAttendChange = vi.fn();
      const env = makeEnv(true, onAttendChange);
      const { bus } = makeBus();
      attachSessionAttention('s1', () => bus, env.deps);

      // Detach via visibility hidden first.
      env.setAttending(false);
      env.fire('document', 'visibilitychange');
      onAttendChange.mockClear();

      env.fire('window', 'pagehide');
      expect(onAttendChange).not.toHaveBeenCalled();
    });

    it('disposer fires (sessionId, false) when previously attending', () => {
      const onAttendChange = vi.fn();
      const env = makeEnv(true, onAttendChange);
      const { bus } = makeBus();
      const dispose = attachSessionAttention('s1', () => bus, env.deps);
      onAttendChange.mockClear();

      dispose();
      expect(onAttendChange).toHaveBeenCalledTimes(1);
      expect(onAttendChange).toHaveBeenCalledWith('s1', false);
    });

    it('disposer does not fire when never attending', () => {
      const onAttendChange = vi.fn();
      const env = makeEnv(false, onAttendChange);
      const { bus } = makeBus();
      const dispose = attachSessionAttention('s1', () => bus, env.deps);
      dispose();
      expect(onAttendChange).not.toHaveBeenCalled();
    });
  });
});
