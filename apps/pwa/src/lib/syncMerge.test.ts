import { describe, it, expect } from 'vitest';
import { mergeSyncPayloads, syncPayloadsEqual, type SyncPayloadV3 } from './syncMerge';
import type { Machine } from '../stores/machineStore';

function makeMachine(overrides: Partial<Machine> & { agentId: string }): Machine {
  return {
    agentId: overrides.agentId,
    publicKey: 'pub',
    signPublicKey: undefined,
    nickname: 'nick',
    icon: 'icon',
    updatedAt: 1000,
    addedAt: 500,
    lastConnectedAt: null,
    lastRepoPath: null,
    knownRepos: [],
    knownCodingPaths: [],
    isPro: false,
    cachedProjects: {},
    ...overrides,
  };
}

function makePayload(overrides: Partial<SyncPayloadV3> = {}): SyncPayloadV3 {
  return {
    version: 3,
    masterSecret: null,
    apiKey: null,
    machines: [],
    machineTombstones: {},
    exportedAt: '2026-04-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('mergeSyncPayloads', () => {
  describe('machines', () => {
    it('unions machines that only exist on one side', () => {
      const a = makePayload({ machines: [makeMachine({ agentId: 'a1' })] });
      const b = makePayload({ machines: [makeMachine({ agentId: 'b1' })] });
      const merged = mergeSyncPayloads(a, b);
      expect(merged.machines.map((m) => m.agentId).sort()).toEqual(['a1', 'b1']);
    });

    it('LWW on synced fields when both sides have the same agent', () => {
      const a = makePayload({
        machines: [makeMachine({ agentId: 'x', nickname: 'old', updatedAt: 100 })],
      });
      const b = makePayload({
        machines: [makeMachine({ agentId: 'x', nickname: 'new', updatedAt: 200 })],
      });
      const merged = mergeSyncPayloads(a, b);
      expect(merged.machines[0].nickname).toBe('new');
      expect(merged.machines[0].updatedAt).toBe(200);
    });

    it('older updatedAt loses even if encountered second', () => {
      const a = makePayload({
        machines: [makeMachine({ agentId: 'x', nickname: 'new', updatedAt: 200 })],
      });
      const b = makePayload({
        machines: [makeMachine({ agentId: 'x', nickname: 'old', updatedAt: 100 })],
      });
      const merged = mergeSyncPayloads(a, b);
      expect(merged.machines[0].nickname).toBe('new');
    });

    it('unions knownRepos and knownCodingPaths', () => {
      const a = makePayload({
        machines: [makeMachine({ agentId: 'x', knownRepos: ['/r1'], knownCodingPaths: ['/c1'] })],
      });
      const b = makePayload({
        machines: [makeMachine({ agentId: 'x', knownRepos: ['/r2'], knownCodingPaths: ['/c1', '/c2'] })],
      });
      const merged = mergeSyncPayloads(a, b);
      expect(merged.machines[0].knownRepos.sort()).toEqual(['/r1', '/r2']);
      expect(merged.machines[0].knownCodingPaths.sort()).toEqual(['/c1', '/c2']);
    });

    it('takes max of lastConnectedAt and preserves that side\'s lastRepoPath', () => {
      const a = makePayload({
        machines: [makeMachine({ agentId: 'x', lastConnectedAt: 100, lastRepoPath: '/old' })],
      });
      const b = makePayload({
        machines: [makeMachine({ agentId: 'x', lastConnectedAt: 500, lastRepoPath: '/new' })],
      });
      const merged = mergeSyncPayloads(a, b);
      expect(merged.machines[0].lastConnectedAt).toBe(500);
      expect(merged.machines[0].lastRepoPath).toBe('/new');
    });

    it('takes min of addedAt (earliest discovery wins)', () => {
      const a = makePayload({ machines: [makeMachine({ agentId: 'x', addedAt: 900 })] });
      const b = makePayload({ machines: [makeMachine({ agentId: 'x', addedAt: 300 })] });
      const merged = mergeSyncPayloads(a, b);
      expect(merged.machines[0].addedAt).toBe(300);
    });

    it('ORs isPro', () => {
      const a = makePayload({ machines: [makeMachine({ agentId: 'x', isPro: false })] });
      const b = makePayload({ machines: [makeMachine({ agentId: 'x', isPro: true })] });
      const merged = mergeSyncPayloads(a, b);
      expect(merged.machines[0].isPro).toBe(true);
    });

    it('merges cachedProjects per cwd, keeping entry with higher lastActivityAt', () => {
      const a = makePayload({
        machines: [
          makeMachine({
            agentId: 'x',
            cachedProjects: {
              '/p1': { lastActivityAt: 100, sessionCount: 1, lastSessionTitle: 'old' },
            },
          }),
        ],
      });
      const b = makePayload({
        machines: [
          makeMachine({
            agentId: 'x',
            cachedProjects: {
              '/p1': { lastActivityAt: 500, sessionCount: 3, lastSessionTitle: 'new' },
              '/p2': { lastActivityAt: 200, sessionCount: 1 },
            },
          }),
        ],
      });
      const merged = mergeSyncPayloads(a, b);
      const cached = merged.machines[0].cachedProjects;
      expect(cached['/p1'].lastActivityAt).toBe(500);
      expect(cached['/p1'].lastSessionTitle).toBe('new');
      expect(cached['/p2'].lastActivityAt).toBe(200);
    });
  });

  describe('tombstones', () => {
    it('tombstone wins when deletedAt > machine.updatedAt', () => {
      const a = makePayload({
        machines: [makeMachine({ agentId: 'x', updatedAt: 100 })],
      });
      const b = makePayload({ machineTombstones: { x: 200 } });
      const merged = mergeSyncPayloads(a, b);
      expect(merged.machines).toHaveLength(0);
      expect(merged.machineTombstones.x).toBe(200);
    });

    it('machine wins when updatedAt > tombstone (revival after delete)', () => {
      const a = makePayload({
        machines: [makeMachine({ agentId: 'x', updatedAt: 300 })],
      });
      const b = makePayload({ machineTombstones: { x: 200 } });
      const merged = mergeSyncPayloads(a, b);
      expect(merged.machines).toHaveLength(1);
      expect(merged.machineTombstones.x).toBeUndefined();
    });

    it('unions tombstones taking max deletedAt', () => {
      const a = makePayload({ machineTombstones: { x: 100, y: 200 } });
      const b = makePayload({ machineTombstones: { x: 150, z: 300 } });
      const merged = mergeSyncPayloads(a, b);
      expect(merged.machineTombstones).toEqual({ x: 150, y: 200, z: 300 });
    });

    it('one-side delete vs other-side edit: whichever has higher timestamp wins', () => {
      // Delete happened at t=200, concurrent edit at t=150 → delete wins.
      const deleted = makePayload({ machineTombstones: { x: 200 } });
      const edited = makePayload({
        machines: [makeMachine({ agentId: 'x', nickname: 'edited', updatedAt: 150 })],
      });
      const m1 = mergeSyncPayloads(deleted, edited);
      expect(m1.machines).toHaveLength(0);

      // Edit at t=250 wins over delete at t=200 → revival.
      const editedLater = makePayload({
        machines: [makeMachine({ agentId: 'x', nickname: 'edited', updatedAt: 250 })],
      });
      const m2 = mergeSyncPayloads(deleted, editedLater);
      expect(m2.machines).toHaveLength(1);
      expect(m2.machines[0].nickname).toBe('edited');
    });
  });

  describe('masterSecret and apiKey', () => {
    it('LWW when both sides present', () => {
      const a = makePayload({ apiKey: { value: 'old', updatedAt: 100 } });
      const b = makePayload({ apiKey: { value: 'new', updatedAt: 200 } });
      const merged = mergeSyncPayloads(a, b);
      expect(merged.apiKey).toEqual({ value: 'new', updatedAt: 200 });
    });

    it('uses non-null side when only one is set', () => {
      const a = makePayload({ masterSecret: null });
      const b = makePayload({ masterSecret: { value: 'secret', updatedAt: 100 } });
      const merged = mergeSyncPayloads(a, b);
      expect(merged.masterSecret).toEqual({ value: 'secret', updatedAt: 100 });
    });

    it('returns null when neither side has one', () => {
      const merged = mergeSyncPayloads(makePayload(), makePayload());
      expect(merged.masterSecret).toBeNull();
      expect(merged.apiKey).toBeNull();
    });
  });

  describe('determinism', () => {
    it('is commutative for independent edits (order of merge does not matter)', () => {
      const a = makePayload({
        machines: [makeMachine({ agentId: 'x', nickname: 'A-edit', updatedAt: 100 })],
      });
      const b = makePayload({
        machines: [makeMachine({ agentId: 'y', nickname: 'B-edit', updatedAt: 100 })],
      });
      const ab = mergeSyncPayloads(a, b);
      const ba = mergeSyncPayloads(b, a);
      expect(syncPayloadsEqual(ab, ba)).toBe(true);
    });

    it('is idempotent: merge(a, a) === a', () => {
      const a = makePayload({
        machines: [
          makeMachine({ agentId: 'x', knownRepos: ['/r1', '/r2'], updatedAt: 100 }),
        ],
        machineTombstones: { z: 50 },
      });
      const merged = mergeSyncPayloads(a, a);
      expect(syncPayloadsEqual(merged, a)).toBe(true);
    });
  });
});

describe('gossip convergence scenarios', () => {
  // Simulates the A/B/C relay race: A and C each push to B, B reads one of
  // them, merges with local, re-pushes. Each device then pulls and merges.
  // Regardless of push order, all three converge on the same payload.

  it('two concurrent edits on different fields of the same machine converge', () => {
    // Base state shared by all three devices.
    const base = makePayload({
      machines: [makeMachine({ agentId: 'm1', nickname: 'base', icon: 'i0', updatedAt: 100 })],
    });

    // A edits the nickname at t=200.
    const a = makePayload({
      machines: [makeMachine({ agentId: 'm1', nickname: 'edited-by-A', icon: 'i0', updatedAt: 200 })],
    });

    // C edits the icon at t=250 (later).
    const c = makePayload({
      machines: [makeMachine({ agentId: 'm1', nickname: 'base', icon: 'edited-by-C', updatedAt: 250 })],
    });

    // B pulls A's push, merges with its base state.
    const bAfterA = mergeSyncPayloads(base, a);
    // B then pulls C's push (which overwrote A's in B's mailbox), merges.
    const bFinal = mergeSyncPayloads(bAfterA, c);

    // C's higher updatedAt (250) wins the whole synced bundle.
    expect(bFinal.machines[0].nickname).toBe('base');
    expect(bFinal.machines[0].icon).toBe('edited-by-C');
    // A's concurrent edit is lost — this is the expected LWW tradeoff.

    // Now B re-pushes to A. A merges into its own state.
    const aFinal = mergeSyncPayloads(a, bFinal);
    expect(aFinal).toEqual(bFinal);

    // And to C.
    const cFinal = mergeSyncPayloads(c, bFinal);
    expect(cFinal).toEqual(bFinal);

    expect(syncPayloadsEqual(aFinal, cFinal)).toBe(true);
  });

  it('concurrent adds of different machines survive the race', () => {
    const a = makePayload({
      machines: [makeMachine({ agentId: 'new-from-A', updatedAt: 100 })],
    });
    const c = makePayload({
      machines: [makeMachine({ agentId: 'new-from-C', updatedAt: 100 })],
    });

    // B has empty state, receives A first then C.
    const bAfterA = mergeSyncPayloads(makePayload(), a);
    const bFinal = mergeSyncPayloads(bAfterA, c);

    expect(bFinal.machines.map((m) => m.agentId).sort()).toEqual(['new-from-A', 'new-from-C']);

    // B re-pushes to both. Both converge.
    expect(mergeSyncPayloads(a, bFinal).machines.map((m) => m.agentId).sort())
      .toEqual(['new-from-A', 'new-from-C']);
    expect(mergeSyncPayloads(c, bFinal).machines.map((m) => m.agentId).sort())
      .toEqual(['new-from-A', 'new-from-C']);
  });

});

describe('syncPayloadsEqual', () => {
  it('treats knownRepos order as insignificant', () => {
    const a = makePayload({
      machines: [makeMachine({ agentId: 'x', knownRepos: ['/a', '/b'] })],
    });
    const b = makePayload({
      machines: [makeMachine({ agentId: 'x', knownRepos: ['/b', '/a'] })],
    });
    expect(syncPayloadsEqual(a, b)).toBe(true);
  });

  it('detects differing nicknames', () => {
    const a = makePayload({
      machines: [makeMachine({ agentId: 'x', nickname: 'one' })],
    });
    const b = makePayload({
      machines: [makeMachine({ agentId: 'x', nickname: 'two' })],
    });
    expect(syncPayloadsEqual(a, b)).toBe(false);
  });
});
