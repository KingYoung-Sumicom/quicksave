// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { CardStreamEnd } from '@sumicom/quicksave-shared';

import type { ThreadTokenUsage } from './schema/generated/v2/ThreadTokenUsage.js';
import type { ThreadTokenUsageUpdatedNotification } from './schema/generated/v2/ThreadTokenUsageUpdatedNotification.js';
import type { TokenUsageBreakdown } from './schema/generated/v2/TokenUsageBreakdown.js';

/**
 * Cumulative seed loaded from `eventStore` on cold resume so per-turn
 * deltas line up after a daemon restart. Mirrors the SDK provider's
 * `loadCumulativeSeed` shape so we can swap providers without touching
 * the eventStore round-trip.
 */
export interface CumulativeUsageSeed {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/**
 * Tracks `thread/tokenUsage/updated` notifications and produces the
 * `tokenUsage` block for `CardStreamEnd` at `turn/completed` time.
 *
 * Key facts about v2's token usage model (verified against codex CLI
 * 0.125.0 — see `docs/references/codex-app-server/implementation-plan.md`
 * §11):
 *
 * - `ThreadTokenUsageUpdatedNotification.tokenUsage.last` is the
 *   **per-turn delta** the server already computed. We pass it through
 *   directly — no slice math required.
 * - `tokenUsage.total` is the running thread-cumulative. We expose it
 *   on `CardStreamEnd.tokenUsage.cumulative*` so the eventStore can
 *   round-trip it for cold resumes.
 * - The notification carries `turnId` so we can key updates per-turn
 *   even when several arrive between `turn/started` and `turn/completed`.
 *
 * Ordering: typically the latest `thread/tokenUsage/updated` precedes
 * `turn/completed` for that turn, but not always. The provider's run
 * loop should `awaitFor(turnId)` briefly when finalizing — see
 * `awaitTurnUsage()`.
 */
export class TokenAccounting {
  /** Latest cumulative we believe the server has, regardless of which
   * turn supplied it. Persisted to eventStore via the run path. */
  private cumulative: CumulativeUsageSeed = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };

  /** Latest `tokenUsage` payload keyed by turnId. */
  private byTurn = new Map<string, ThreadTokenUsage>();

  /** Pending awaiters waiting for a usage notification on a specific turn. */
  private waiters = new Map<string, Array<(usage: ThreadTokenUsage) => void>>();

  seedFromLastTurn(seed: CumulativeUsageSeed | null | undefined): void {
    if (!seed) return;
    this.cumulative = {
      inputTokens: seed.inputTokens,
      outputTokens: seed.outputTokens,
      cachedInputTokens: seed.cachedInputTokens ?? 0,
    };
  }

  /**
   * Feed a `thread/tokenUsage/updated` notification. Updates the
   * running cumulative and per-turn caches, and resolves any active
   * waiters.
   */
  observe(notification: ThreadTokenUsageUpdatedNotification): void {
    this.byTurn.set(notification.turnId, notification.tokenUsage);
    this.cumulative = {
      inputTokens: notification.tokenUsage.total.inputTokens,
      outputTokens: notification.tokenUsage.total.outputTokens,
      cachedInputTokens: notification.tokenUsage.total.cachedInputTokens,
    };
    const ws = this.waiters.get(notification.turnId);
    if (ws) {
      this.waiters.delete(notification.turnId);
      for (const w of ws) w(notification.tokenUsage);
    }
  }

  /**
   * Wait for a `thread/tokenUsage/updated` notification carrying
   * `turnId`. Resolves immediately if one was already observed.
   * Resolves to `null` if `timeoutMs` elapses first (the run loop
   * should still emit `CardStreamEnd` — better an empty usage block
   * than a hung turn).
   */
  awaitTurnUsage(turnId: string, timeoutMs: number): Promise<ThreadTokenUsage | null> {
    const cached = this.byTurn.get(turnId);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const arr = this.waiters.get(turnId);
        if (arr) {
          const idx = arr.indexOf(onUsage);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) this.waiters.delete(turnId);
        }
        resolve(null);
      }, timeoutMs);
      const onUsage = (usage: ThreadTokenUsage): void => {
        clearTimeout(timer);
        resolve(usage);
      };
      const arr = this.waiters.get(turnId) ?? [];
      arr.push(onUsage);
      this.waiters.set(turnId, arr);
    });
  }

  /** Drop any state for a turn — call after stream-end is emitted to
   * keep the per-turn cache from growing unboundedly. */
  releaseTurn(turnId: string): void {
    this.byTurn.delete(turnId);
    this.waiters.delete(turnId);
  }

  /** Map a `ThreadTokenUsage` payload to the `CardStreamEnd.tokenUsage`
   * shape. Returns undefined when the input is null. */
  static toCardStreamEndUsage(
    usage: ThreadTokenUsage | null | undefined,
  ): CardStreamEnd['tokenUsage'] {
    if (!usage) return undefined;
    return {
      input: usage.last.inputTokens,
      output: usage.last.outputTokens,
      cumulativeInput: usage.total.inputTokens,
      cumulativeOutput: usage.total.outputTokens,
      cumulativeCachedInput: usage.total.cachedInputTokens,
    };
  }

  /** Snapshot the running cumulative — used by the run path to
   * persist `LastTurnInfo` after every successful turn end. */
  snapshotCumulative(): CumulativeUsageSeed {
    return { ...this.cumulative };
  }
}

/** Build a synthetic `ThreadTokenUsage` from a per-turn breakdown plus
 * a precomputed cumulative — used in tests. */
export function makeUsage(
  last: TokenUsageBreakdown,
  total: TokenUsageBreakdown,
  modelContextWindow: number | null = null,
): ThreadTokenUsage {
  return { last, total, modelContextWindow };
}

/** Build a `TokenUsageBreakdown` literal — used in tests. */
export function makeBreakdown(input: number, output: number, cachedInput = 0): TokenUsageBreakdown {
  return {
    totalTokens: input + output,
    inputTokens: input,
    cachedInputTokens: cachedInput,
    outputTokens: output,
    reasoningOutputTokens: 0,
  };
}
