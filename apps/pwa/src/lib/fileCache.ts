// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Two-tier cache for `files:read` responses, layered on the shared
 * `blobCache` machinery.
 *
 * Cache key fingerprint: `${cwd}\0${path}\0${maxBytes ?? ''}\0${allowImage}`
 * — same input → same cached output. No content hash because the agent
 * already returns `mtime`+`size` in metadata; for our use case (file
 * viewer opening the same path repeatedly within a session) the input
 * fingerprint is the natural cache key. Cross-session invalidation is
 * coarse: cached entries are returned even if the file changed on disk
 * since the last read. Callers that know about a write should call
 * `invalidateFileCache(cwd, path)` to flush.
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

export function readWithCache(
  req: FilesReadRequestPayload,
  fetcher: (req: FilesReadRequestPayload) => Promise<FilesReadResponsePayload>,
): Promise<FilesReadResponsePayload> {
  return fileCache.read(req, fetcher);
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
