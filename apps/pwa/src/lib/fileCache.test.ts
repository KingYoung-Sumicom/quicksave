import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  FilesReadRequestPayload,
  FilesReadResponsePayload,
} from '@sumicom/quicksave-shared';
import {
  readWithCache,
  invalidateFileCache,
  clearFileCache,
  cacheKeyFor,
  entryBytesOf,
  _resetFileCacheForTest,
  _l1StatsForTest,
} from './fileCache';

// jsdom does not provide IndexedDB. Every L2 path is wrapped in
// try/catch so the cache silently downgrades to L1-only here. Tests
// therefore exercise L1 behaviour and the public API contract; they
// don't assert on persistence across reload.

function ok(extra?: Partial<FilesReadResponsePayload>): FilesReadResponsePayload {
  return {
    success: true,
    cwd: '/p',
    path: 'a.md',
    absolutePath: '/p/a.md',
    kind: 'text',
    content: 'hello',
    encoding: 'utf-8',
    size: 5,
    mtime: 1,
    ...extra,
  };
}

describe('fileCache', () => {
  beforeEach(() => {
    _resetFileCacheForTest();
  });

  describe('cacheKeyFor', () => {
    it('produces the same key for identical requests', () => {
      const a = cacheKeyFor({ cwd: '/p', path: 'a.md' });
      const b = cacheKeyFor({ cwd: '/p', path: 'a.md' });
      expect(a).toBe(b);
    });

    it('distinguishes maxBytes and allowImage variants', () => {
      const base = { cwd: '/p', path: 'a.png' };
      const k1 = cacheKeyFor(base);
      const k2 = cacheKeyFor({ ...base, maxBytes: 5000 });
      const k3 = cacheKeyFor({ ...base, allowImage: true });
      expect(new Set([k1, k2, k3]).size).toBe(3);
    });

    it('uses NUL separator so paths with spaces do not alias other fields', () => {
      // "a /b" + cwd "" must not collide with cwd "a" + path "/b".
      const k1 = cacheKeyFor({ cwd: '', path: 'a /b' });
      const k2 = cacheKeyFor({ cwd: 'a', path: '/b' });
      expect(k1).not.toBe(k2);
    });
  });

  describe('entryBytesOf', () => {
    it('counts string content length plus a small overhead', () => {
      expect(entryBytesOf(ok({ content: 'abc' }))).toBe(3 + 256);
      expect(entryBytesOf(ok({ content: '' }))).toBe(256);
    });

    it('returns just the overhead when content is absent (binary/oversized)', () => {
      expect(
        entryBytesOf({
          success: true,
          kind: 'binary',
          size: 999,
        }),
      ).toBe(256);
    });
  });

  describe('readWithCache — basic hit/miss', () => {
    it('first call hits the fetcher; second call returns from cache without re-fetching', async () => {
      const req: FilesReadRequestPayload = { cwd: '/p', path: 'a.md' };
      const fetcher = vi.fn(async () => ok());

      const r1 = await readWithCache(req, fetcher);
      const r2 = await readWithCache(req, fetcher);

      expect(r1).toEqual(ok());
      expect(r2).toEqual(ok());
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('different requests do not share cache entries', async () => {
      const fetcher = vi.fn(async (req: FilesReadRequestPayload) =>
        ok({ path: req.path, content: req.path }),
      );

      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'b.md' }, fetcher);

      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('does NOT cache failed responses — re-fetches on next call', async () => {
      const req: FilesReadRequestPayload = { cwd: '/p', path: 'missing.md' };
      const fetcher = vi.fn(async () => ({
        success: false,
        cwd: '/p',
        path: 'missing.md',
        error: 'ENOENT',
      } satisfies FilesReadResponsePayload));

      await readWithCache(req, fetcher);
      await readWithCache(req, fetcher);

      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('caches each (maxBytes, allowImage) variant separately', async () => {
      const fetcher = vi.fn(async () => ok());
      await readWithCache({ cwd: '/p', path: 'a.png' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'a.png', allowImage: true }, fetcher);
      // Same path but different request fingerprint → second fetch.
      expect(fetcher).toHaveBeenCalledTimes(2);

      // Repeating both variants — both should be cache hits.
      await readWithCache({ cwd: '/p', path: 'a.png' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'a.png', allowImage: true }, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('readWithCache — concurrency', () => {
    it('two parallel reads of the same file currently both hit the fetcher (no in-flight dedup)', async () => {
      // Documenting the current contract: we don't coalesce in-flight
      // requests. If the same file is requested twice in parallel before
      // either resolves, both go to the network. This keeps the cache
      // simple — the second response just overwrites the first in L1.
      const req: FilesReadRequestPayload = { cwd: '/p', path: 'a.md' };
      const fetcher = vi.fn(async () => ok());
      const [r1, r2] = await Promise.all([
        readWithCache(req, fetcher),
        readWithCache(req, fetcher),
      ]);
      expect(r1.content).toBe('hello');
      expect(r2.content).toBe('hello');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateFileCache', () => {
    it('flushes cached entries for a (cwd, path) across all variants', async () => {
      const fetcher = vi.fn(async () => ok());

      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'a.md', allowImage: true }, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);

      invalidateFileCache('/p', 'a.md');

      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'a.md', allowImage: true }, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

    it('does not flush unrelated paths', async () => {
      const fetcher = vi.fn(async (req: FilesReadRequestPayload) =>
        ok({ path: req.path }),
      );

      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'b.md' }, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);

      invalidateFileCache('/p', 'a.md');

      // a.md should re-fetch; b.md should still be a cache hit.
      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'b.md' }, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(3);
    });
  });

  describe('clearFileCache', () => {
    it('drops every cached entry', async () => {
      const fetcher = vi.fn(async () => ok());
      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'b.md' }, fetcher);
      expect(_l1StatsForTest().count).toBe(2);

      clearFileCache();
      expect(_l1StatsForTest().count).toBe(0);

      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'b.md' }, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(4);
    });
  });

  describe('L1 LRU eviction', () => {
    it('evicts oldest entries once the byte cap is exceeded', async () => {
      // Fabricate a payload large enough that a handful exceeds 50 MB.
      // 12 MB content per entry → 5 entries = 60 MB, forces at least one
      // eviction.
      const big = 'x'.repeat(12 * 1024 * 1024);
      const fetcher = vi.fn(async (req: FilesReadRequestPayload) =>
        ok({ path: req.path, content: big }),
      );

      for (let i = 0; i < 5; i++) {
        await readWithCache({ cwd: '/p', path: `f${i}.md` }, fetcher);
      }
      // Total is over the 50 MB cap, so at least the oldest entry was
      // evicted. Bytes counter must remain ≤ cap.
      const stats = _l1StatsForTest();
      expect(stats.bytes).toBeLessThanOrEqual(50 * 1024 * 1024);
      expect(stats.count).toBeLessThan(5);

      // Re-asking for the oldest path forces a re-fetch (it was evicted).
      await readWithCache({ cwd: '/p', path: 'f0.md' }, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(6);
    });

    it('refreshes LRU order on hit — recently-read entries survive eviction longer', async () => {
      const big = 'y'.repeat(12 * 1024 * 1024);
      const fetcher = vi.fn(async (req: FilesReadRequestPayload) =>
        ok({ path: req.path, content: big }),
      );

      // Insert 3 entries (~36 MB total — under cap).
      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'b.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'c.md' }, fetcher);

      // Touch 'a.md' so it becomes the most recent.
      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);

      // Insert two more — now we're well over cap; the oldest survivors
      // should be 'b.md' (oldest, evicted first) before 'a.md'.
      await readWithCache({ cwd: '/p', path: 'd.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'e.md' }, fetcher);

      // 'a.md' was touched recently — it should still be cached.
      const callsBefore = fetcher.mock.calls.length;
      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      expect(fetcher.mock.calls.length).toBe(callsBefore); // hit, no new call

      // 'b.md' was the oldest — it should have been evicted.
      await readWithCache({ cwd: '/p', path: 'b.md' }, fetcher);
      expect(fetcher.mock.calls.length).toBe(callsBefore + 1); // miss
    });
  });
});
