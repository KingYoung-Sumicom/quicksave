import { describe, it, expect } from 'vitest';
import { SyncStore } from './syncStore.js';

/**
 * Unit tests for the per-mailbox write lock on `SyncStore`. Blob / tombstone
 * semantics are covered in `syncStore.test.ts`; this file focuses on the
 * `tryAcquireLock` / `releaseLock` / `peekLock` surface, using an injected
 * `now()` so we can advance time deterministically.
 */

interface Clock {
  current: number;
}

function makeStore(opts?: { lockTtlMs?: number }): { store: SyncStore; clock: Clock } {
  const clock: Clock = { current: 1_000 };
  const store = new SyncStore({
    maxBlobSize: 8192,
    lockTtlMs: opts?.lockTtlMs ?? 10_000,
    now: () => clock.current,
  });
  return { store, clock };
}

describe('SyncStore locks', () => {
  it('tryAcquireLock returns ok=true with expiresAt when no existing lock', () => {
    const { store, clock } = makeStore();
    const result = store.tryAcquireLock('key1', 'pubA');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expiresAt).toBe(clock.current + 10_000);
    }
  });

  it('same sigPubkey re-acquiring refreshes the TTL', () => {
    const { store, clock } = makeStore();
    const first = store.tryAcquireLock('key1', 'pubA');
    expect(first.ok).toBe(true);
    const firstExpiresAt = first.ok ? first.expiresAt : -1;

    // Advance the clock within the TTL window, then re-acquire.
    clock.current += 5_000;
    const second = store.tryAcquireLock('key1', 'pubA');
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.expiresAt).toBeGreaterThan(firstExpiresAt);
      expect(second.expiresAt).toBe(clock.current + 10_000);
    }
  });

  it('different sigPubkey within TTL returns ok=false with heldBy', () => {
    const { store } = makeStore();
    store.tryAcquireLock('key1', 'pubA');

    const result = store.tryAcquireLock('key1', 'pubB');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.heldBy.sigPubkey).toBe('pubA');
    }
  });

  it('different sigPubkey after TTL expiry takes ownership', () => {
    const { store, clock } = makeStore();
    store.tryAcquireLock('key1', 'pubA');

    // Advance past the lock TTL.
    clock.current += 10_001;
    const result = store.tryAcquireLock('key1', 'pubB');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expiresAt).toBe(clock.current + 10_000);
    }

    // Confirm the holder actually changed.
    const peeked = store.peekLock('key1');
    expect(peeked?.sigPubkey).toBe('pubB');
  });

  it('releaseLock returns true when the caller holds it', () => {
    const { store } = makeStore();
    store.tryAcquireLock('key1', 'pubA');
    expect(store.releaseLock('key1', 'pubA')).toBe(true);
    expect(store.peekLock('key1')).toBeNull();
  });

  it('releaseLock returns false when a different key holds it; lock stays', () => {
    const { store } = makeStore();
    store.tryAcquireLock('key1', 'pubA');

    const released = store.releaseLock('key1', 'pubB');
    expect(released).toBe(false);

    // Lock should still be held by pubA.
    const peeked = store.peekLock('key1');
    expect(peeked?.sigPubkey).toBe('pubA');
  });

  it('releaseLock after TTL expiry returns true and clears the entry', () => {
    const { store, clock } = makeStore();
    store.tryAcquireLock('key1', 'pubA');

    clock.current += 10_001;
    // An expired lock is treated as released regardless of caller identity.
    const released = store.releaseLock('key1', 'pubB');
    expect(released).toBe(true);
    expect(store.peekLock('key1')).toBeNull();
  });

  it('releaseLock on a non-existent key returns false', () => {
    const { store } = makeStore();
    expect(store.releaseLock('missing', 'pubA')).toBe(false);
  });

  it('peekLock returns the active lock, null for expired, null for missing', () => {
    const { store, clock } = makeStore();

    // Missing.
    expect(store.peekLock('absent')).toBeNull();

    // Active.
    store.tryAcquireLock('key1', 'pubA');
    const active = store.peekLock('key1');
    expect(active).not.toBeNull();
    expect(active?.sigPubkey).toBe('pubA');
    expect(active?.expiresAt).toBe(clock.current + 10_000);

    // Expired → null (and the entry is GC'd as a side-effect).
    clock.current += 10_001;
    expect(store.peekLock('key1')).toBeNull();
  });

  it('stats.locks reflects active (non-expired) locks only', () => {
    const { store, clock } = makeStore();
    expect(store.stats.locks).toBe(0);

    store.tryAcquireLock('key1', 'pubA');
    store.tryAcquireLock('key2', 'pubB');
    expect(store.stats.locks).toBe(2);

    // After expiry, the active count drops to zero even though entries still
    // physically exist in the underlying map until the next peek/release.
    clock.current += 10_001;
    expect(store.stats.locks).toBe(0);
  });

  it('stats.locks decrements when a lock is released', () => {
    const { store } = makeStore();
    store.tryAcquireLock('key1', 'pubA');
    store.tryAcquireLock('key2', 'pubB');
    expect(store.stats.locks).toBe(2);

    store.releaseLock('key1', 'pubA');
    expect(store.stats.locks).toBe(1);

    store.releaseLock('key2', 'pubB');
    expect(store.stats.locks).toBe(0);
  });

  it('distinct keyHashes hold independent locks', () => {
    const { store } = makeStore();

    expect(store.tryAcquireLock('key1', 'pubA').ok).toBe(true);
    // A different mailbox is unaffected by key1's lock.
    expect(store.tryAcquireLock('key2', 'pubB').ok).toBe(true);

    // And pubA is blocked from key2 even though it owns key1.
    const result = store.tryAcquireLock('key2', 'pubA');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.heldBy.sigPubkey).toBe('pubB');
    }

    // Releasing key1 doesn't affect key2's lock.
    store.releaseLock('key1', 'pubA');
    expect(store.peekLock('key2')?.sigPubkey).toBe('pubB');
  });
});
