// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type {
  CodexQuotaSnapshot,
  CodexQuotaWindow,
  CodexQuotaWindowId,
} from '@sumicom/quicksave-shared';
import { spawnAppServer } from './codexAppServer/index.js';
import type { GetAccountRateLimitsResponse } from './codexAppServer/schema/generated/v2/GetAccountRateLimitsResponse.js';
import type { RateLimitSnapshot } from './codexAppServer/schema/generated/v2/RateLimitSnapshot.js';
import type { RateLimitWindow } from './codexAppServer/schema/generated/v2/RateLimitWindow.js';

export const CODEX_QUOTA_TTL_MS = 5 * 60 * 1000;

type QuotaFetcher = (ttlMs: number) => Promise<CodexQuotaSnapshot>;

export class CodexQuotaService {
  private cache: CodexQuotaSnapshot | null = null;
  private refreshInFlight: Promise<CodexQuotaSnapshot> | null = null;
  private updateHandler: ((snapshot: CodexQuotaSnapshot) => void) | null = null;

  constructor(
    private readonly ttlMs = CODEX_QUOTA_TTL_MS,
    private readonly fetcher: QuotaFetcher = fetchCodexQuotaFromAppServer,
  ) {}

  setUpdateHandler(handler: (snapshot: CodexQuotaSnapshot) => void): void {
    this.updateHandler = handler;
  }

  getSnapshot(): CodexQuotaSnapshot | null {
    return this.cache ? withStaleFlag(this.cache, this.ttlMs) : null;
  }

  refresh(opts: { force?: boolean } = {}): Promise<CodexQuotaSnapshot> {
    const cached = this.getSnapshot();
    if (!opts.force && cached && !cached.stale) return Promise.resolve(cached);
    if (this.refreshInFlight) return this.refreshInFlight;

    const refresh = (async () => {
      try {
        const snapshot = await this.fetcher(this.ttlMs);
        this.cache = snapshot;
        this.updateHandler?.(snapshot);
        return snapshot;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const previous = this.getSnapshot();
        const snapshot: CodexQuotaSnapshot = previous
          ? { ...previous, stale: true, error }
          : {
              source: 'app-server',
              fetchedAt: Date.now(),
              ttlMs: this.ttlMs,
              stale: false,
              windows: [],
              error,
            };
        this.cache = snapshot;
        this.updateHandler?.(snapshot);
        return snapshot;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    this.refreshInFlight = refresh;
    return refresh;
  }

  refreshIfStale(): void {
    const snapshot = this.getSnapshot();
    if (!snapshot || snapshot.stale) {
      void this.refresh().catch(() => {
        /* refresh() normalizes errors into snapshots */
      });
    }
  }
}

export async function fetchCodexQuotaFromAppServer(ttlMs = CODEX_QUOTA_TTL_MS): Promise<CodexQuotaSnapshot> {
  let handle: Awaited<ReturnType<typeof spawnAppServer>> | null = null;
  try {
    handle = await spawnAppServer({
      clientInfo: { name: 'quicksave-agent', title: 'Quicksave Agent', version: '0.0.0' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: null },
    });
    const response = await handle.rpc.request<GetAccountRateLimitsResponse>(
      'account/rateLimits/read',
      undefined,
    );
    return projectCodexQuotaResponse(response, ttlMs);
  } finally {
    if (handle) {
      try { await handle.shutdown(); } catch { /* best-effort */ }
    }
  }
}

export function projectCodexQuotaResponse(
  response: GetAccountRateLimitsResponse,
  ttlMs = CODEX_QUOTA_TTL_MS,
  now = Date.now(),
): CodexQuotaSnapshot {
  const limits = selectCodexRateLimits(response);
  return {
    source: 'app-server',
    fetchedAt: now,
    ttlMs,
    stale: false,
    windows: [
      projectRateLimitWindow(limits.primary, 'five_hour'),
      projectRateLimitWindow(limits.secondary, 'seven_day'),
    ].filter((w): w is CodexQuotaWindow => Boolean(w)),
  };
}

export function selectCodexRateLimits(response: GetAccountRateLimitsResponse): RateLimitSnapshot {
  const byId = response.rateLimitsByLimitId;
  return byId?.codex
    ?? Object.values(byId ?? {}).find((value): value is RateLimitSnapshot => Boolean(value))
    ?? response.rateLimits;
}

function projectRateLimitWindow(
  window: RateLimitWindow | null,
  fallbackId: Exclude<CodexQuotaWindowId, 'unknown'>,
): CodexQuotaWindow | null {
  if (!window) return null;
  const duration = window.windowDurationMins;
  const id = idForDuration(duration, fallbackId);
  return {
    id,
    label: labelForDuration(duration, id),
    usedPercent: normalizePercent(window.usedPercent),
    resetAt: normalizeEpochMs(window.resetsAt),
    windowDurationMins: duration,
  };
}

function idForDuration(
  minutes: number | null,
  fallbackId: Exclude<CodexQuotaWindowId, 'unknown'>,
): CodexQuotaWindowId {
  if (!minutes) return fallbackId;
  if (minutes === 300) return 'five_hour';
  if (minutes === 10_080) return 'seven_day';
  return 'unknown';
}

function labelForDuration(minutes: number | null, id: CodexQuotaWindowId): string {
  if (minutes === 300) return '5h';
  if (minutes === 10_080) return '7d';
  if (!minutes && id === 'five_hour') return '5h';
  if (!minutes && id === 'seven_day') return '7d';
  if (!minutes || minutes <= 0) return 'quota';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function normalizePercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeEpochMs(value: number | null): number | null {
  if (!value || !Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function withStaleFlag(snapshot: CodexQuotaSnapshot, ttlMs: number): CodexQuotaSnapshot {
  return {
    ...snapshot,
    stale: Date.now() - snapshot.fetchedAt >= ttlMs,
  };
}
