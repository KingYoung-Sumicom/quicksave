// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ClaudeQuotaModelWindow, ClaudeQuotaSnapshot, ClaudeQuotaWindow, ClaudeQuotaWindowId } from '@sumicom/quicksave-shared';

/** Default staleness window. `get_usage` is only refreshed when an active
 *  Claude Code CLI session answers a turn-end probe (see run.ts), so this is
 *  deliberately long — there is no standalone poll path like Codex quota. */
export const CLAUDE_QUOTA_TTL_MS = 30 * 60 * 1000;

/** Raw shape of the CLI's `get_usage` control_request response. Marked
 *  experimental upstream (the CLI's own SDK method is named
 *  `EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) — every field here
 *  is treated as optional/nullable and parsing fails soft.
 *  See docs/references/claude-code-cli-control-requests.md#get_usage. */
export interface ClaudeUsageRawResponse {
  session?: unknown;
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: RawWindow | null;
    seven_day?: RawWindow | null;
    seven_day_oauth_apps?: RawWindow | null;
    seven_day_opus?: RawWindow | null;
    seven_day_sonnet?: RawWindow | null;
    model_scoped?: Array<{ display_name?: unknown; utilization?: unknown; resets_at?: unknown }> | null;
  } | null;
}

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

const WINDOW_LABELS: Record<ClaudeQuotaWindowId, string> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_oauth_apps: '7d (OAuth apps)',
  seven_day_opus: '7d (Opus)',
  seven_day_sonnet: '7d (Sonnet)',
};

/** Pure projection from the CLI's raw `get_usage` response to our shared
 *  snapshot type. Never throws — malformed/missing fields are dropped rather
 *  than surfaced, since the upstream shape is explicitly unstable. */
export function projectClaudeUsage(
  raw: ClaudeUsageRawResponse | null | undefined,
  ttlMs = CLAUDE_QUOTA_TTL_MS,
  now = Date.now(),
): ClaudeQuotaSnapshot {
  const subscriptionType = normalizeSubscriptionType(raw?.subscription_type);
  const rateLimitsAvailable = raw?.rate_limits_available === true;
  const rl = raw?.rate_limits ?? null;

  const windows: ClaudeQuotaWindow[] = [];
  if (rl) {
    (Object.keys(WINDOW_LABELS) as ClaudeQuotaWindowId[]).forEach((id) => {
      const window = projectWindow(id, rl[id]);
      if (window) windows.push(window);
    });
  }

  const modelWindows = rl?.model_scoped?.map(projectModelWindow).filter((w): w is ClaudeQuotaModelWindow => w !== null);

  return {
    source: 'cli',
    fetchedAt: now,
    ttlMs,
    stale: false,
    subscriptionType,
    rateLimitsAvailable,
    windows,
    ...(modelWindows && modelWindows.length > 0 ? { modelWindows } : {}),
  };
}

function projectWindow(id: ClaudeQuotaWindowId, raw: RawWindow | null | undefined): ClaudeQuotaWindow | null {
  if (!raw || typeof raw.utilization !== 'number' || !Number.isFinite(raw.utilization)) return null;
  return {
    id,
    label: WINDOW_LABELS[id],
    usedPercent: Math.max(0, Math.min(100, raw.utilization)),
    resetAt: normalizeIsoToEpochMs(raw.resets_at),
  };
}

function projectModelWindow(entry: { display_name?: unknown; utilization?: unknown; resets_at?: unknown }): ClaudeQuotaModelWindow | null {
  const displayName = typeof entry.display_name === 'string' ? entry.display_name.trim() : '';
  if (!displayName) return null;
  const utilization = typeof entry.utilization === 'number' && Number.isFinite(entry.utilization)
    ? Math.max(0, Math.min(100, entry.utilization))
    : null;
  return {
    displayName,
    usedPercent: utilization,
    resetAt: normalizeIsoToEpochMs(entry.resets_at),
  };
}

function normalizeSubscriptionType(value: string | null | undefined): ClaudeQuotaSnapshot['subscriptionType'] {
  return value === 'pro' || value === 'max' || value === 'team' || value === 'enterprise' ? value : null;
}

function normalizeIsoToEpochMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function withStaleFlag(snapshot: ClaudeQuotaSnapshot, ttlMs: number): ClaudeQuotaSnapshot {
  return { ...snapshot, stale: snapshot.stale || Date.now() - snapshot.fetchedAt >= ttlMs };
}

/** Agent-wide cache of the most recent `get_usage` projection. There is no
 *  self-initiated fetch here (unlike `CodexQuotaService`) — `ingest()` is fed
 *  by whichever active Claude Code session last answered a `get_usage` probe
 *  (see run.ts's turn-end hook, mirroring the existing context-usage probe). */
export class ClaudeQuotaCache {
  private cache: ClaudeQuotaSnapshot | null = null;
  private updateHandler: ((snapshot: ClaudeQuotaSnapshot) => void) | null = null;

  constructor(private readonly ttlMs = CLAUDE_QUOTA_TTL_MS) {}

  setUpdateHandler(handler: (snapshot: ClaudeQuotaSnapshot) => void): void {
    this.updateHandler = handler;
  }

  getSnapshot(): ClaudeQuotaSnapshot | null {
    return this.cache ? withStaleFlag(this.cache, this.ttlMs) : null;
  }

  /** Project and cache a raw `get_usage` response. Silently ignores responses
   *  with no usable rate-limit data (e.g. API-key sessions) rather than
   *  clobbering a previously-populated snapshot from a subscription session. */
  ingest(raw: ClaudeUsageRawResponse | null | undefined): void {
    if (!raw) return;
    const snapshot = projectClaudeUsage(raw, this.ttlMs);
    if (!snapshot.rateLimitsAvailable) return;
    this.cache = snapshot;
    this.updateHandler?.(snapshot);
  }
}
