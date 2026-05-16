// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Two-tier cache for `files:read` responses, layered on the shared
 * `blobCache` machinery.
 *
 * Cache key fingerprint: `${cwd}\0${path}\0${maxBytes ?? ''}\0${allowImage}`
 * — same input → same cached output.
 *
 * Freshness: every cached hit triggers an HTTP-style conditional GET. The
 * client sends `ifNoneMatch: "${mtime}-${size}"` from the cached entry;
 * the agent stat()s the file and short-circuits with `notModified: true`
 * when the fingerprint still matches, skipping the disk read. On a real
 * change the fresh response replaces the cached entry. Net effect:
 * always-fresh body, one round-trip + a stat per open, body bytes only
 * when the file actually changed.
 *
 * `invalidateFileCache(cwd, path)` still exists for callers that want to
 * force-drop an entry (refresh button, external knowledge of a write).
 */

import type {
  FilesReadRequestPayload,
  FilesReadResponsePayload,
} from '@sumicom/quicksave-shared';
import { createBlobCache } from './blobCache';

const fileCache = createBlobCache<FilesReadRequestPayload, FilesReadResponsePayload>({
  dbName: 'quicksave-file-cache',
  l1MaxBytes: 50 * 1024 * 1024,
  l2MaxBytes: 100 * 1024 * 1024,
  keyFn: (req) => `${req.cwd} ${req.path} ${req.maxBytes ?? ''} ${req.allowImage ? '1' : '0'}`,
  bytesFn: (res) => entryBytesOf(res),
  shouldCache: (res) => res.success,
});

export function cacheKeyFor(req: FilesReadRequestPayload): string {
  return `${req.cwd} ${req.path} ${req.maxBytes ?? ''} ${req.allowImage ? '1' : '0'}`;
}

/** Approximate byte cost of a cached response — drives LRU eviction.
 *  String content's `length` is char count (≈ bytes for ASCII / base64);
 *  exact bytes don't matter, only the relative size signal does. */
export function entryBytesOf(res: FilesReadResponsePayload): number {
  const contentLen = typeof res.content === 'string' ? res.content.length : 0;
  return contentLen + 256;
}

export async function readWithCache(
  req: FilesReadRequestPayload,
  fetcher: (req: FilesReadRequestPayload) => Promise<FilesReadResponsePayload>,
): Promise<FilesReadResponsePayload> {
  const cached = await fileCache.peek(req);
  const etag = etagFor(cached);
  if (cached && etag) {
    // Conditional revalidation — send the etag, expect 304 or full body.
    const fresh = await fetcher({ ...req, ifNoneMatch: etag });
    if (fresh.success && fresh.notModified) {
      return cached;
    }
    if (fresh.success) {
      fileCache.prime(req, fresh);
      return fresh;
    }
    // Failure response — don't poison the cache, surface the error and
    // leave the existing cached entry intact for the next attempt.
    return fresh;
  }
  // Cold path — no cached entry to revalidate against.
  return fileCache.read(req, fetcher);
}

/** Build an `If-None-Match` token from a cached response, or undefined
 *  when the entry lacks the metadata we'd need to revalidate (e.g. an
 *  ancient primed entry without mtime/size). */
function etagFor(res: FilesReadResponsePayload | undefined): string | undefined {
  if (!res || !res.success) return undefined;
  if (typeof res.mtime !== 'number' || typeof res.size !== 'number') return undefined;
  return `${res.mtime}-${res.size}`;
}

/** Drop every cached entry for a specific (cwd, path) — across all
 *  maxBytes/allowImage variants. Call after a write you can attribute to
 *  a known file. */
export function invalidateFileCache(cwd: string, path: string): void {
  fileCache.invalidatePrefix(`${cwd} ${path} `);
}

/** Drop everything. Use sparingly — e.g., on session switch when paths
 *  may collide across cwds, or for a manual "refresh" UI affordance. */
export function clearFileCache(): void {
  fileCache.clear();
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export function _resetFileCacheForTest(): void {
  fileCache._resetForTest();
}

export function _l1StatsForTest(): { count: number; bytes: number } {
  return fileCache._l1Stats();
}
