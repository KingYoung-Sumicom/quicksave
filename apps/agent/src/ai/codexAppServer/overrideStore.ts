import type { ApprovalsReviewer } from './schema/generated/v2/ApprovalsReviewer.js';
import type { AskForApproval } from './schema/generated/v2/AskForApproval.js';
import type { PermissionProfile } from './schema/generated/v2/PermissionProfile.js';
import type { ReasoningEffort } from './schema/generated/ReasoningEffort.js';
import type { SandboxPolicy } from './schema/generated/v2/SandboxPolicy.js';

/**
 * The set of TurnStartParams fields that we treat as runtime-mutable.
 * This is a strict subset of the full TurnStartParams override surface
 * — we only expose the dimensions Quicksave's UI surfaces today
 * (model / effort / permission). Other sticky fields (cwd,
 * personality, serviceTier, summary, collaborationMode) can be added
 * incrementally as the UI grows.
 */
export interface RuntimeOverrides {
  model?: string | null;
  effort?: ReasoningEffort | null;
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: SandboxPolicy | null;
  permissionProfile?: PermissionProfile | null;
  approvalsReviewer?: ApprovalsReviewer | null;
}

const KEYS: readonly (keyof RuntimeOverrides)[] = [
  'model',
  'effort',
  'approvalPolicy',
  'sandboxPolicy',
  'permissionProfile',
  'approvalsReviewer',
];

/**
 * Stores the server's current effective overrides for a thread plus
 * any pending changes the user has made via `setSessionConfig` /
 * `setPermissionLevel` since the last `turn/start`. The provider
 * `drain()`s this store right before sending each `turn/start` and
 * `commit()`s after the request acknowledges, so what we send on the
 * wire is the diff between what the user just asked for and what the
 * server already has.
 *
 * Why a diff: app-server's per-turn override semantics are sticky —
 * once a value is set it persists until overridden again. Re-sending
 * the same `effort: 'medium'` every turn is harmless on the server
 * but adds noise to logs and PR diffs.
 */
export class RuntimeOverrideStore {
  /** What the server has currently accepted as the thread default.
   * Seeded from `thread/start` / `thread/resume` response. */
  private serverEffective: RuntimeOverrides = {};
  /** What the user has changed since the last drain. Drained on each
   * `turn/start`. */
  private pendingForNextTurn: RuntimeOverrides = {};

  /** Seed `serverEffective` from a `thread/start` /
   * `thread/resume` response. Resets any pending overrides because
   * we've just reconciled with the server. */
  reseedFromServer(initial: RuntimeOverrides): void {
    this.serverEffective = sanitizePatch(initial);
    this.pendingForNextTurn = {};
  }

  /** Queue a user-driven change to apply on the next `turn/start`.
   * `null` is a "clear" sentinel; `undefined` means "leave alone".
   * Multiple calls before drain merge — last write wins per key. */
  enqueue(patch: RuntimeOverrides): void {
    const cleaned = sanitizePatch(patch);
    for (const key of KEYS) {
      if (key in cleaned) {
        // We treat `null` as "explicitly clear" — the v2 protocol
        // accepts null for these fields too, meaning "use server
        // default". Store as-is.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.pendingForNextTurn as any)[key] = (cleaned as any)[key];
      }
    }
  }

  /** Returns the patch that should be attached to the next
   * `turn/start`. Filters out fields whose pending value matches the
   * already-effective server value (no-op overrides). The store
   * itself is unchanged — caller must `commit()` after the request
   * succeeds. */
  drain(): RuntimeOverrides {
    const out: RuntimeOverrides = {};
    for (const key of KEYS) {
      if (!(key in this.pendingForNextTurn)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending = (this.pendingForNextTurn as any)[key];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const effective = (this.serverEffective as any)[key];
      if (deepEqual(pending, effective)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[key] = pending;
    }
    return out;
  }

  /** Promote `pendingForNextTurn` into `serverEffective`. Call after
   * the matching `turn/start` request returns success. */
  commit(): void {
    for (const key of KEYS) {
      if (!(key in this.pendingForNextTurn)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.serverEffective as any)[key] = (this.pendingForNextTurn as any)[key];
    }
    this.pendingForNextTurn = {};
  }

  /** True when there are queued user-driven changes not yet sent. */
  hasPending(): boolean {
    return Object.keys(this.pendingForNextTurn).length > 0;
  }

  /** Test-only — read the effective view. */
  effectiveSnapshot(): RuntimeOverrides {
    return { ...this.serverEffective };
  }

  /** Test-only — read the pending view. */
  pendingSnapshot(): RuntimeOverrides {
    return { ...this.pendingForNextTurn };
  }
}

function sanitizePatch(patch: RuntimeOverrides): RuntimeOverrides {
  const out: RuntimeOverrides = {};
  for (const key of KEYS) {
    if (key in patch) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[key] = (patch as any)[key];
    }
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
