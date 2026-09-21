// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

export function recordSessionHistoryMetric(
  event: 'cache_hit' | 'cache_miss' | 'cache_write' | 'snapshot' | 'reconnect',
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  if (!import.meta.env.DEV) return;
  console.debug(`[session-history] ${event}`, fields);
}
