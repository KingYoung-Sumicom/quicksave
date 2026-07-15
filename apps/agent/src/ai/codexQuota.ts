// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type {
  CodexQuotaResetCredit,
  CodexQuotaSnapshot,
  CodexQuotaWindow,
  CodexQuotaWindowId,
} from '@sumicom/quicksave-shared';
import { spawnAppServer } from './codexAppServer/index.js';
import type { GetAccountRateLimitsResponse } from './codexAppServer/schema/generated/v2/GetAccountRateLimitsResponse.js';
import type { RateLimitSnapshot } from './codexAppServer/schema/generated/v2/RateLimitSnapshot.js';
import type { RateLimitWindow } from './codexAppServer/schema/generated/v2/RateLimitWindow.js';

export const CODEX_QUOTA_TTL_MS = 5 * 60 * 1000;
export const CODEX_QUOTA_DEBOUNCE_MS = 3 * 60 * 1000;
const TEMPORARY_UNAVAILABLE_ERROR = 'Codex quota is temporarily unavailable from ChatGPT. Quicksave will retry automatically.';
const AUTH_UNAVAILABLE_ERROR = 'Codex quota is unavailable because Codex is not signed in. Sign in again if this persists.';

type QuotaFetcher = (ttlMs: number) => Promise<CodexQuotaSnapshot>;

export class CodexQuotaService {
  private cache: CodexQuotaSnapshot | null = null;
  private refreshInFlight: Promise<CodexQuotaSnapshot> | null = null;
  private updateHandler: ((snapshot: CodexQuotaSnapshot) => void) | null = null;
  private lastRefreshAttemptAt: number | null = null;

  constructor(
    private readonly ttlMs = CODEX_QUOTA_TTL_MS,
    private readonly fetcher: QuotaFetcher = fetchCodexQuotaFromAppServer,
    private readonly debounceMs = CODEX_QUOTA_DEBOUNCE_MS,
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
    if (cached && this.isDebounced()) return Promise.resolve(cached);

    const refresh = (async () => {
      this.lastRefreshAttemptAt = Date.now();
      try {
        const snapshot = await this.fetcher(this.ttlMs);
        this.cache = snapshot;
        this.updateHandler?.(snapshot);
        return snapshot;
      } catch (err) {
        const rawError = err instanceof Error ? err.message : String(err);
        const error = summarizeCodexQuotaError(err);
        console.warn('[codex-quota] refresh failed:', rawError);
        const previous = this.getSnapshot();
        const snapshot: CodexQuotaSnapshot = previous
          ? { ...previous, stale: true, error }
          : {
              source: 'app-server',
              fetchedAt: Date.now(),
              ttlMs: this.ttlMs,
              stale: true,
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

  private isDebounced(now = Date.now()): boolean {
    return this.lastRefreshAttemptAt !== null
      && now - this.lastRefreshAttemptAt < this.debounceMs;
  }
}

export async function fetchCodexQuotaFromAppServer(ttlMs = CODEX_QUOTA_TTL_MS): Promise<CodexQuotaSnapshot> {
  let handle: Awaited<ReturnType<typeof spawnAppServer>> | null = null;
  try {
    handle = await spawnAppServer({
      clientInfo: { name: 'quicksave-agent', title: 'Quicksave Agent', version: '0.0.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
        optOutNotificationMethods: null,
      },
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
    resetCredits: response.rateLimitResetCredits
      ? {
          availableCount: numberFromBigInt(response.rateLimitResetCredits.availableCount),
          credits: response.rateLimitResetCredits.credits?.map(projectResetCredit) ?? null,
        }
      : null,
  };
}

function numberFromBigInt(value: bigint): number {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : Number.MAX_SAFE_INTEGER;
}

function projectResetCredit(credit: {
  id: string;
  resetType: string;
  status: string;
  grantedAt: number;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}): CodexQuotaResetCredit {
  return {
    id: credit.id,
    resetType: credit.resetType,
    status: credit.status,
    grantedAt: normalizeEpochMs(credit.grantedAt) ?? 0,
    expiresAt: normalizeEpochMs(credit.expiresAt),
    title: credit.title,
    description: credit.description,
  };
}

export function selectCodexRateLimits(response: GetAccountRateLimitsResponse): RateLimitSnapshot {
  const byId = response.rateLimitsByLimitId;
  return byId?.codex
    ?? Object.values(byId ?? {}).find((value): value is RateLimitSnapshot => Boolean(value))
    ?? response.rateLimits;
}

export function summarizeCodexQuotaError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  if (
    lower.includes('503')
    || lower.includes('service unavailable')
    || lower.includes('upstream connect error')
    || lower.includes('remote connection failure')
    || lower.includes('connection refused')
    || lower.includes('econnreset')
    || lower.includes('timeout')
  ) {
    return TEMPORARY_UNAVAILABLE_ERROR;
  }

  if (
    lower.includes('401')
    || lower.includes('403')
    || lower.includes('unauthorized')
    || lower.includes('forbidden')
    || lower.includes('not logged in')
  ) {
    return AUTH_UNAVAILABLE_ERROR;
  }

  if (!normalized) return 'Codex quota is unavailable. Quicksave will retry automatically.';
  const summary = normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
  return `Codex quota is unavailable: ${summary}`;
}

function projectRateLimitWindow(
  window: RateLimitWindow | null,
  fallbackId: Exclude<CodexQuotaWindowId, 'unknown'>,
): CodexQuotaWindow | null {
  if (!window) return null;
  const rawUsedPercent = (window as { usedPercent?: unknown }).usedPercent;
  if (typeof rawUsedPercent !== 'number' || !Number.isFinite(rawUsedPercent)) return null;
  const duration = window.windowDurationMins;
  const id = idForDuration(duration, fallbackId);
  return {
    id,
    label: labelForDuration(duration, id),
    usedPercent: normalizePercent(rawUsedPercent),
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
    stale: Boolean(snapshot.error) || snapshot.stale || Date.now() - snapshot.fetchedAt >= ttlMs,
  };
}
