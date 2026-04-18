import type {
  Machine,
  PinnedProjectState,
  CachedProjectData,
} from '../stores/machineStore';

/** Last-write-wins wrapper for a single scalar value. */
export interface Timestamped<T> {
  value: T;
  updatedAt: number;
}

/**
 * Bi-directional sync payload. Every mutable field carries its own timestamp
 * so concurrent edits from different devices can be merged field-by-field.
 */
export interface SyncPayloadV3 {
  version: 3;
  masterSecret: Timestamped<string> | null;
  apiKey: Timestamped<string> | null;
  machines: Machine[];
  /** agentId → deletedAt (ms). Supersedes a machine with older updatedAt. */
  machineTombstones: Record<string, number>;
  /** projectId → { pinned, updatedAt }. pinned=false is a soft tombstone. */
  pinnedProjects: Record<string, PinnedProjectState>;
  exportedAt: string;
}

/**
 * Pick the timestamped value with the higher updatedAt. Null loses to any
 * real value. Ties break toward `a` (caller convention: local wins ties).
 */
function pickLatest<T>(
  a: Timestamped<T> | null | undefined,
  b: Timestamped<T> | null | undefined,
): Timestamped<T> | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}

function unionStrings(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

function mergeCachedProjects(
  a: Record<string, CachedProjectData> | undefined,
  b: Record<string, CachedProjectData> | undefined,
): Record<string, CachedProjectData> {
  const out: Record<string, CachedProjectData> = { ...(a ?? {}) };
  for (const [cwd, bEntry] of Object.entries(b ?? {})) {
    const aEntry = out[cwd];
    if (!aEntry) {
      out[cwd] = bEntry;
      continue;
    }
    // Take whichever side has higher lastActivityAt; prefer its repos too.
    if (bEntry.lastActivityAt > aEntry.lastActivityAt) {
      out[cwd] = {
        ...bEntry,
        // Preserve repos if remote side lacks them.
        repos: bEntry.repos ?? aEntry.repos,
      };
    } else {
      out[cwd] = {
        ...aEntry,
        repos: aEntry.repos ?? bEntry.repos,
      };
    }
  }
  return out;
}

/**
 * Merge two machines representing the same agentId.
 * Synced fields (publicKey, signPublicKey, nickname, icon) use LWW by
 * `updatedAt`. Local-only fields are unioned (sets) or take max/min as
 * appropriate — none of those fields are ever the "wrong" answer, only
 * more or less complete.
 */
function mergeMachine(a: Machine, b: Machine): Machine {
  const synced = b.updatedAt > a.updatedAt ? b : a;
  const aFirst = a.addedAt <= b.addedAt;
  return {
    agentId: a.agentId,
    publicKey: synced.publicKey,
    signPublicKey: synced.signPublicKey,
    nickname: synced.nickname,
    icon: synced.icon,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),

    addedAt: aFirst ? a.addedAt : b.addedAt,
    lastConnectedAt: Math.max(a.lastConnectedAt ?? 0, b.lastConnectedAt ?? 0) || null,
    lastRepoPath:
      (a.lastConnectedAt ?? 0) >= (b.lastConnectedAt ?? 0) ? a.lastRepoPath : b.lastRepoPath,
    knownRepos: unionStrings(a.knownRepos, b.knownRepos),
    knownCodingPaths: unionStrings(a.knownCodingPaths, b.knownCodingPaths),
    isPro: a.isPro || b.isPro,
    cachedProjects: mergeCachedProjects(a.cachedProjects, b.cachedProjects),
  };
}

/**
 * Merge two SyncPayloadV3 blobs. Deterministic and side-effect free.
 *
 * Semantics:
 * - masterSecret / apiKey: LWW by updatedAt.
 * - machines: per-agentId merge. Tombstone wins if deletedAt > updatedAt,
 *   otherwise the machine survives and the tombstone is dropped.
 * - machineTombstones: union, take max deletedAt per agentId. Drop tombstones
 *   superseded by a revived machine.
 * - pinnedProjects: per-projectId LWW by updatedAt.
 */
export function mergeSyncPayloads(a: SyncPayloadV3, b: SyncPayloadV3): SyncPayloadV3 {
  // Tombstones: union with max(deletedAt).
  const tombstones: Record<string, number> = { ...a.machineTombstones };
  for (const [agentId, ts] of Object.entries(b.machineTombstones)) {
    tombstones[agentId] = Math.max(tombstones[agentId] ?? 0, ts);
  }

  // Machines: merge by agentId, then filter against tombstones.
  const byId = new Map<string, Machine>();
  for (const m of a.machines) byId.set(m.agentId, m);
  for (const m of b.machines) {
    const existing = byId.get(m.agentId);
    byId.set(m.agentId, existing ? mergeMachine(existing, m) : m);
  }

  const machines: Machine[] = [];
  for (const m of byId.values()) {
    const tombstoneAt = tombstones[m.agentId];
    if (tombstoneAt !== undefined && tombstoneAt >= m.updatedAt) {
      // Tombstone wins — drop the machine.
      continue;
    }
    if (tombstoneAt !== undefined && m.updatedAt > tombstoneAt) {
      // Machine was revived after deletion — drop the stale tombstone.
      delete tombstones[m.agentId];
    }
    machines.push(m);
  }

  // Pinned projects: LWW per projectId.
  const pinnedProjects: Record<string, PinnedProjectState> = { ...a.pinnedProjects };
  for (const [id, entry] of Object.entries(b.pinnedProjects)) {
    const existing = pinnedProjects[id];
    if (!existing || entry.updatedAt > existing.updatedAt) {
      pinnedProjects[id] = entry;
    }
  }

  return {
    version: 3,
    masterSecret: pickLatest(a.masterSecret, b.masterSecret),
    apiKey: pickLatest(a.apiKey, b.apiKey),
    machines,
    machineTombstones: tombstones,
    pinnedProjects,
    exportedAt: a.exportedAt >= b.exportedAt ? a.exportedAt : b.exportedAt,
  };
}

/**
 * Deep-equal for sync payloads, used to decide whether merging a pulled
 * payload actually changed local state (skip re-push if not).
 *
 * Order-insensitive for arrays keyed by stable ids (machines, knownRepos,
 * knownCodingPaths).
 */
export function syncPayloadsEqual(a: SyncPayloadV3, b: SyncPayloadV3): boolean {
  if (!timestampedEqual(a.masterSecret, b.masterSecret)) return false;
  if (!timestampedEqual(a.apiKey, b.apiKey)) return false;
  if (!recordEqual(a.machineTombstones, b.machineTombstones)) return false;
  if (!pinnedEqual(a.pinnedProjects, b.pinnedProjects)) return false;

  if (a.machines.length !== b.machines.length) return false;
  const bMap = new Map(b.machines.map((m) => [m.agentId, m]));
  for (const am of a.machines) {
    const bm = bMap.get(am.agentId);
    if (!bm || !machinesEqual(am, bm)) return false;
  }
  return true;
}

function timestampedEqual<T>(
  a: Timestamped<T> | null,
  b: Timestamped<T> | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.value === b.value && a.updatedAt === b.updatedAt;
}

function recordEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function pinnedEqual(
  a: Record<string, PinnedProjectState>,
  b: Record<string, PinnedProjectState>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    if (!av || !bv) return false;
    if (av.pinned !== bv.pinned || av.updatedAt !== bv.updatedAt) return false;
  }
  return true;
}

function machinesEqual(a: Machine, b: Machine): boolean {
  if (a.agentId !== b.agentId) return false;
  if (a.publicKey !== b.publicKey) return false;
  if (a.signPublicKey !== b.signPublicKey) return false;
  if (a.nickname !== b.nickname) return false;
  if (a.icon !== b.icon) return false;
  if (a.updatedAt !== b.updatedAt) return false;
  if (a.addedAt !== b.addedAt) return false;
  if (a.lastConnectedAt !== b.lastConnectedAt) return false;
  if (a.lastRepoPath !== b.lastRepoPath) return false;
  if (a.isPro !== b.isPro) return false;
  if (!stringSetEqual(a.knownRepos, b.knownRepos)) return false;
  if (!stringSetEqual(a.knownCodingPaths, b.knownCodingPaths)) return false;
  if (!cachedProjectsEqual(a.cachedProjects, b.cachedProjects)) return false;
  return true;
}

function stringSetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const v of b) if (!set.has(v)) return false;
  return true;
}

function cachedProjectsEqual(
  a: Record<string, CachedProjectData>,
  b: Record<string, CachedProjectData>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    if (!av || !bv) return false;
    if (av.lastActivityAt !== bv.lastActivityAt) return false;
    if (av.sessionCount !== bv.sessionCount) return false;
    if (av.lastSessionTitle !== bv.lastSessionTitle) return false;
    if (!reposEqual(av.repos, bv.repos)) return false;
  }
  return true;
}

function reposEqual(
  a: CachedProjectData['repos'],
  b: CachedProjectData['repos'],
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const byPath = new Map(a.map((r) => [r.path, r]));
  for (const r of b) {
    const match = byPath.get(r.path);
    if (!match) return false;
    if (match.name !== r.name || match.currentBranch !== r.currentBranch || match.isSubmodule !== r.isSubmodule) {
      return false;
    }
  }
  return true;
}
