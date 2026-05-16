// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
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

function notModified(extra?: Partial<FilesReadResponsePayload>): FilesReadResponsePayload {
  return {
    success: true,
    cwd: '/p',
    path: 'a.md',
    absolutePath: '/p/a.md',
    size: 5,
    mtime: 1,
    notModified: true,
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

  describe('readWithCache — cold path', () => {
    it('first call hits the fetcher with no ifNoneMatch and caches the response', async () => {
      const req: FilesReadRequestPayload = { cwd: '/p', path: 'a.md' };
      const fetcher = vi.fn(async (_p: FilesReadRequestPayload) => ok());

      const r1 = await readWithCache(req, fetcher);
      expect(r1).toEqual(ok());
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][0]).not.toHaveProperty('ifNoneMatch');
    });

    it('different requests do not share cache entries', async () => {
      const fetcher = vi.fn(async (req: FilesReadRequestPayload) =>
        ok({ path: req.path, content: req.path }),
      );

      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'b.md' }, fetcher);

      expect(fetcher).toHaveBeenCalledTimes(2);
      // Neither call carried an ifNoneMatch — both were cold reads.
      expect(fetcher.mock.calls[0][0]).not.toHaveProperty('ifNoneMatch');
      expect(fetcher.mock.calls[1][0]).not.toHaveProperty('ifNoneMatch');
    });

    it('does NOT cache failed responses — re-fetches cold on next call', async () => {
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
      // Both calls are cold (no cached entry to revalidate against).
      expect(fetcher.mock.calls[0][0]).not.toHaveProperty('ifNoneMatch');
      expect(fetcher.mock.calls[1][0]).not.toHaveProperty('ifNoneMatch');
    });
  });

  describe('readWithCache — conditional revalidation', () => {
    it('warm hit revalidates: fetcher receives ifNoneMatch, cached body returned on notModified', async () => {
      const req: FilesReadRequestPayload = { cwd: '/p', path: 'a.md' };
      let nthCall = 0;
      const fetcher = vi.fn(async (p: FilesReadRequestPayload) => {
        nthCall += 1;
        if (nthCall === 1) return ok(); // cold response
        // Revalidation call must carry ifNoneMatch derived from mtime+size.
        expect(p.ifNoneMatch).toBe('1-5');
        return notModified();
      });

      const r1 = await readWithCache(req, fetcher);
      const r2 = await readWithCache(req, fetcher);

      expect(r1.content).toBe('hello');
      // Revalidated response — content is taken from the cached entry,
      // not from the notModified stub (which has no content).
      expect(r2.content).toBe('hello');
      expect(r2.kind).toBe('text');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('warm hit on a changed file: fresh body replaces cache, subsequent revalidation uses new etag', async () => {
      const req: FilesReadRequestPayload = { cwd: '/p', path: 'a.md' };
      const calls: FilesReadRequestPayload[] = [];
      let nthCall = 0;
      const fetcher = vi.fn(async (p: FilesReadRequestPayload) => {
        calls.push(p);
        nthCall += 1;
        if (nthCall === 1) return ok({ content: 'v1', size: 2, mtime: 1 });
        if (nthCall === 2) return ok({ content: 'v2', size: 2, mtime: 2 });
        // 3rd call should revalidate against the *new* etag.
        expect(p.ifNoneMatch).toBe('2-2');
        return notModified({ size: 2, mtime: 2 });
      });

      const r1 = await readWithCache(req, fetcher);
      expect(r1.content).toBe('v1');
      // Call 2: revalidation hits but server reports fresh content → cache replaced.
      const r2 = await readWithCache(req, fetcher);
      expect(r2.content).toBe('v2');
      expect(calls[1].ifNoneMatch).toBe('1-2');
      // Call 3: cache now holds v2 with mtime=2/size=2 → etag becomes "2-2".
      const r3 = await readWithCache(req, fetcher);
      expect(r3.content).toBe('v2');
      expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it('failed revalidation leaves the cached entry intact and returns the failure', async () => {
      const req: FilesReadRequestPayload = { cwd: '/p', path: 'a.md' };
      let nthCall = 0;
      const fetcher = vi.fn(async () => {
        nthCall += 1;
        if (nthCall === 1) return ok();
        if (nthCall === 2)
          return {
            success: false,
            cwd: '/p',
            path: 'a.md',
            error: 'transient',
          } satisfies FilesReadResponsePayload;
        // Third call should still revalidate against the original cached etag,
        // proving the failure didn't poison the cache.
        return notModified();
      });

      await readWithCache(req, fetcher);
      const r2 = await readWithCache(req, fetcher);
      expect(r2.success).toBe(false);
      expect(r2.error).toBe('transient');

      const r3 = await readWithCache(req, fetcher);
      expect(r3.success).toBe(true);
      expect(r3.content).toBe('hello');
      expect((fetcher.mock.calls[2][0] as FilesReadRequestPayload).ifNoneMatch).toBe('1-5');
    });

    it('caches each (maxBytes, allowImage) variant separately', async () => {
      const fetcher = vi.fn(async (req: FilesReadRequestPayload) => {
        // Cold response only — tests never hit revalidation here.
        if (req.ifNoneMatch) return notModified();
        return ok();
      });
      await readWithCache({ cwd: '/p', path: 'a.png' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'a.png', allowImage: true }, fetcher);
      // Same path but different request fingerprint → both cold.
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[0][0]).not.toHaveProperty('ifNoneMatch');
      expect(fetcher.mock.calls[1][0]).not.toHaveProperty('ifNoneMatch');

      // Repeating both variants — each now revalidates separately.
      await readWithCache({ cwd: '/p', path: 'a.png' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'a.png', allowImage: true }, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(4);
      expect((fetcher.mock.calls[2][0] as FilesReadRequestPayload).ifNoneMatch).toBe('1-5');
      expect((fetcher.mock.calls[3][0] as FilesReadRequestPayload).ifNoneMatch).toBe('1-5');
    });
  });

  describe('readWithCache — concurrency', () => {
    it('two parallel reads of the same file both hit the fetcher (no in-flight dedup)', async () => {
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
      const fetcher = vi.fn(async (req: FilesReadRequestPayload) =>
        req.ifNoneMatch ? notModified() : ok(),
      );

      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'a.md', allowImage: true }, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);

      invalidateFileCache('/p', 'a.md');

      // After invalidation both reads must go cold again (no ifNoneMatch).
      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'a.md', allowImage: true }, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(fetcher.mock.calls[2][0]).not.toHaveProperty('ifNoneMatch');
      expect(fetcher.mock.calls[3][0]).not.toHaveProperty('ifNoneMatch');
    });

    it('does not flush unrelated paths', async () => {
      const fetcher = vi.fn(async (req: FilesReadRequestPayload) =>
        req.ifNoneMatch ? notModified({ path: req.path }) : ok({ path: req.path }),
      );

      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'b.md' }, fetcher);

      invalidateFileCache('/p', 'a.md');

      // 'a.md' must go cold; 'b.md' should still revalidate (warm).
      await readWithCache({ cwd: '/p', path: 'a.md' }, fetcher);
      await readWithCache({ cwd: '/p', path: 'b.md' }, fetcher);

      expect(fetcher).toHaveBeenCalledTimes(4);
      const aCold = fetcher.mock.calls[2][0] as FilesReadRequestPayload;
      const bWarm = fetcher.mock.calls[3][0] as FilesReadRequestPayload;
      expect(aCold.path).toBe('a.md');
      expect(aCold).not.toHaveProperty('ifNoneMatch');
      expect(bWarm.path).toBe('b.md');
      expect(bWarm.ifNoneMatch).toBe('1-5');
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
    });
  });

  describe('L1 LRU eviction', () => {
    it('evicts oldest entries once the byte cap is exceeded', async () => {
      // Fabricate a payload large enough that a handful exceeds 50 MB.
      // 12 MB content per entry → 5 entries = 60 MB, forces at least one
      // eviction.
      const big = 'x'.repeat(12 * 1024 * 1024);
      const fetcher = vi.fn(async (req: FilesReadRequestPayload) =>
        ok({ path: req.path, content: big, size: big.length, mtime: 1 }),
      );

      for (let i = 0; i < 5; i++) {
        await readWithCache({ cwd: '/p', path: `f${i}.md` }, fetcher);
      }
      // Total is over the 50 MB cap, so at least the oldest entry was
      // evicted. Bytes counter must remain ≤ cap.
      const stats = _l1StatsForTest();
      expect(stats.bytes).toBeLessThanOrEqual(50 * 1024 * 1024);
      expect(stats.count).toBeLessThan(5);
    });
  });
});
