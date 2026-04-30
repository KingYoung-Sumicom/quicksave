// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  statSync,
} from 'fs';
import {
  FileBrowser,
  getFileBrowser,
  _resetFileBrowserForTest,
} from './fileBrowser.js';

describe('FileBrowser', () => {
  let root: string;
  let fb: FileBrowser;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'quicksave-fb-'));
    _resetFileBrowserForTest();
    fb = getFileBrowser();
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    _resetFileBrowserForTest();
  });

  // -------------------------------------------------------------------------
  // Path resolution (no sandbox — see module docstring)
  // -------------------------------------------------------------------------
  describe('path resolution', () => {
    it('read() with absolute path uses it verbatim regardless of cwd', async () => {
      // A file outside `root` (in a sibling tmpdir) must still be readable
      // when addressed by absolute path.
      const otherRoot = mkdtempSync(join(tmpdir(), 'quicksave-fb-other-'));
      try {
        const target = join(otherRoot, 'outside.txt');
        writeFileSync(target, 'outside content');
        const res = await fb.read({ cwd: root, path: target });
        expect(res.success).toBe(true);
        expect(res.kind).toBe('text');
        expect(res.content).toBe('outside content');
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });

    it('list() with absolute path uses it verbatim regardless of cwd', async () => {
      const otherRoot = mkdtempSync(join(tmpdir(), 'quicksave-fb-other-'));
      try {
        writeFileSync(join(otherRoot, 'a.txt'), 'a');
        const res = await fb.list({ cwd: root, path: otherRoot });
        expect(res.success).toBe(true);
        expect(res.entries!.map((e) => e.name)).toContain('a.txt');
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });

    it('absolute path works with empty cwd', async () => {
      const otherRoot = mkdtempSync(join(tmpdir(), 'quicksave-fb-other-'));
      try {
        writeFileSync(join(otherRoot, 'a.txt'), 'hello');
        const res = await fb.read({ cwd: '', path: join(otherRoot, 'a.txt') });
        expect(res.success).toBe(true);
        expect(res.content).toBe('hello');
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });

    it('relative path with empty cwd fails with a clear error', async () => {
      const res = await fb.read({ cwd: '', path: 'a.txt' });
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
    });

    it('relative ".." traversal is allowed (no sandbox)', async () => {
      // Create a file in the parent of `root` and read it via "../<name>".
      // It will be inside the tmpdir, just outside the project root.
      const sibling = mkdtempSync(join(tmpdir(), 'quicksave-fb-sib-'));
      try {
        writeFileSync(join(sibling, 'parent.txt'), 'from parent');
        // From inside `root`, `../<basename(sibling)>/parent.txt` walks up
        // to the shared tmpdir then back down into the sibling.
        const rel = `../${sibling.split('/').pop()}/parent.txt`;
        const res = await fb.read({ cwd: root, path: rel });
        expect(res.success).toBe(true);
        expect(res.kind).toBe('text');
        expect(res.content).toBe('from parent');
      } finally {
        rmSync(sibling, { recursive: true, force: true });
      }
    });

    it('accepts path === "" (lists cwd itself)', async () => {
      writeFileSync(join(root, 'a.txt'), 'a');
      const res = await fb.list({ cwd: root, path: '' });
      expect(res.success).toBe(true);
      expect(res.entries).toBeDefined();
    });

    it('accepts path === "." (lists cwd itself)', async () => {
      writeFileSync(join(root, 'a.txt'), 'a');
      const res = await fb.list({ cwd: root, path: '.' });
      expect(res.success).toBe(true);
      expect(res.entries).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // list()
  // -------------------------------------------------------------------------
  describe('list()', () => {
    it('returns immediate children with directories first then files, alpha-sorted', async () => {
      mkdirSync(join(root, 'zeta-dir'));
      mkdirSync(join(root, 'alpha-dir'));
      writeFileSync(join(root, 'beta.txt'), 'beta');
      writeFileSync(join(root, 'apple.txt'), 'apple');

      const res = await fb.list({ cwd: root, path: '' });
      expect(res.success).toBe(true);
      const names = res.entries!.map((e) => e.name);
      // dirs first (alpha among themselves), then files (alpha).
      expect(names).toEqual(['alpha-dir', 'zeta-dir', 'apple.txt', 'beta.txt']);
    });

    it('FileEntry has name (basename), kind, size, mtime; dirs have size 0', async () => {
      mkdirSync(join(root, 'subdir'));
      writeFileSync(join(root, 'hello.txt'), 'hello world');

      const res = await fb.list({ cwd: root, path: '' });
      expect(res.success).toBe(true);

      const dir = res.entries!.find((e) => e.name === 'subdir')!;
      expect(dir.name).toBe('subdir'); // basename only
      expect(dir.kind).toBe('directory');
      expect(dir.size).toBe(0);
      expect(typeof dir.mtime).toBe('number');
      expect(dir.mtime).toBeGreaterThan(0);

      const file = res.entries!.find((e) => e.name === 'hello.txt')!;
      expect(file.kind).toBe('file');
      expect(file.size).toBe('hello world'.length);
      expect(typeof file.mtime).toBe('number');
    });

    it('marks files larger than the 100 KiB cap as oversized: true', async () => {
      const big = Buffer.alloc(150 * 1024, 0x41); // 150 KiB of 'A'
      writeFileSync(join(root, 'big.txt'), big);

      const res = await fb.list({ cwd: root, path: '' });
      const entry = res.entries!.find((e) => e.name === 'big.txt')!;
      expect(entry.kind).toBe('file');
      expect(entry.size).toBe(big.length);
      expect(entry.oversized).toBe(true);
    });

    it('files at/below the 100 KiB cap are not oversized', async () => {
      writeFileSync(join(root, 'small.txt'), 'tiny');
      const res = await fb.list({ cwd: root, path: '' });
      const entry = res.entries!.find((e) => e.name === 'small.txt')!;
      // spec: oversized = size > 100*1024. So `false` or `undefined`.
      expect(entry.oversized === false || entry.oversized === undefined).toBe(true);
    });

    it('symlink entries have kind "symlink" and targetIsDirectory set when pointing to a dir', async () => {
      mkdirSync(join(root, 'real-dir'));
      writeFileSync(join(root, 'real-file.txt'), 'real');
      symlinkSync(join(root, 'real-dir'), join(root, 'link-to-dir'));
      symlinkSync(join(root, 'real-file.txt'), join(root, 'link-to-file'));

      const res = await fb.list({ cwd: root, path: '' });
      expect(res.success).toBe(true);

      const dirLink = res.entries!.find((e) => e.name === 'link-to-dir')!;
      expect(dirLink.kind).toBe('symlink');
      expect(dirLink.targetIsDirectory).toBe(true);

      const fileLink = res.entries!.find((e) => e.name === 'link-to-file')!;
      expect(fileLink.kind).toBe('symlink');
      // Pointing at a regular file — must NOT report targetIsDirectory true.
      expect(fileLink.targetIsDirectory).not.toBe(true);
    });

    it('returns success: false with an error when the path is a regular file', async () => {
      writeFileSync(join(root, 'a.txt'), 'a');
      const res = await fb.list({ cwd: root, path: 'a.txt' });
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
      expect(typeof res.error).toBe('string');
    });

    it('returns success: false with an error for non-existent paths', async () => {
      const res = await fb.list({ cwd: root, path: 'nope/does/not/exist' });
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
    });

    it('echoes cwd and path back; sets absolutePath on success', async () => {
      mkdirSync(join(root, 'sub'));
      const res = await fb.list({ cwd: root, path: 'sub' });
      expect(res.success).toBe(true);
      expect(res.cwd).toBe(root);
      expect(res.path).toBe('sub');
      expect(typeof res.absolutePath).toBe('string');
      expect(res.absolutePath!.endsWith('sub')).toBe(true);
    });

    it('lists nested directory contents', async () => {
      mkdirSync(join(root, 'sub'));
      writeFileSync(join(root, 'sub', 'inner.txt'), 'inner');
      const res = await fb.list({ cwd: root, path: 'sub' });
      expect(res.success).toBe(true);
      const names = res.entries!.map((e) => e.name);
      expect(names).toContain('inner.txt');
    });
  });

  // -------------------------------------------------------------------------
  // read()
  // -------------------------------------------------------------------------
  describe('read()', () => {
    it('returns kind "text" with utf-8 content for a small text file', async () => {
      const body = 'hello, world\nline 2\n';
      writeFileSync(join(root, 'a.txt'), body);
      const stat = statSync(join(root, 'a.txt'));

      const res = await fb.read({ cwd: root, path: 'a.txt' });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('text');
      expect(res.content).toBe(body);
      expect(res.encoding).toBe('utf-8');
      expect(res.size).toBe(stat.size);
      expect(typeof res.mtime).toBe('number');
    });

    it('returns kind "binary" with no content when a NUL byte appears in the first 8 KiB', async () => {
      const buf = Buffer.from([0x48, 0x00, 0x69]); // H, NUL, i
      writeFileSync(join(root, 'bin.dat'), buf);
      const stat = statSync(join(root, 'bin.dat'));

      const res = await fb.read({ cwd: root, path: 'bin.dat' });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('binary');
      expect(res.content).toBeUndefined();
      expect(res.size).toBe(stat.size);
      expect(typeof res.mtime).toBe('number');
    });

    it('returns kind "oversized" with no content for files exceeding the default 100 KiB cap', async () => {
      const big = Buffer.alloc(150 * 1024, 0x41);
      writeFileSync(join(root, 'big.txt'), big);
      const stat = statSync(join(root, 'big.txt'));

      const res = await fb.read({ cwd: root, path: 'big.txt' });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('oversized');
      expect(res.content).toBeUndefined();
      expect(res.size).toBe(stat.size);
      expect(typeof res.mtime).toBe('number');
    });

    it('maxBytes: 10 against a 100-byte file returns kind "oversized"', async () => {
      const body = 'x'.repeat(100);
      writeFileSync(join(root, 'm.txt'), body);

      const res = await fb.read({ cwd: root, path: 'm.txt', maxBytes: 10 });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('oversized');
      expect(res.content).toBeUndefined();
    });

    it('maxBytes: 1000 against a 100-byte file returns kind "text" with full content', async () => {
      const body = 'x'.repeat(100);
      writeFileSync(join(root, 'm.txt'), body);

      const res = await fb.read({ cwd: root, path: 'm.txt', maxBytes: 1000 });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('text');
      expect(res.content).toBe(body);
    });

    it('maxBytes is clamped to a 512 KiB ceiling — 100M does not bypass the safety cap; a 200 KiB file still succeeds', async () => {
      // 200 KiB file with no NULs → text, well within the 512 KiB ceiling.
      const buf = Buffer.alloc(200 * 1024, 0x41);
      writeFileSync(join(root, 'big.txt'), buf);

      const res = await fb.read({
        cwd: root,
        path: 'big.txt',
        maxBytes: 100_000_000,
      });
      expect(res.success).toBe(true);
      // 200 KiB ≤ 512 KiB ceiling → readable as text.
      expect(res.kind).toBe('text');
      expect(res.content!.length).toBe(buf.length);
    });

    it('returns success: false with an error when reading a directory', async () => {
      mkdirSync(join(root, 'dir'));
      const res = await fb.read({ cwd: root, path: 'dir' });
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
      expect(res.content).toBeUndefined();
    });

    it('returns success: false for non-existent files', async () => {
      const res = await fb.read({ cwd: root, path: 'no-such-file.txt' });
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
    });

    it('echoes cwd and path back; sets absolutePath on success', async () => {
      writeFileSync(join(root, 'a.txt'), 'a');
      const res = await fb.read({ cwd: root, path: 'a.txt' });
      expect(res.success).toBe(true);
      expect(res.cwd).toBe(root);
      expect(res.path).toBe('a.txt');
      expect(typeof res.absolutePath).toBe('string');
      expect(res.absolutePath!.endsWith('a.txt')).toBe(true);
    });

    it('reads an empty file as text with empty content', async () => {
      writeFileSync(join(root, 'empty.txt'), '');
      const res = await fb.read({ cwd: root, path: 'empty.txt' });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('text');
      expect(res.content).toBe('');
      expect(res.size).toBe(0);
    });

    it('reads UTF-8 multi-byte content correctly', async () => {
      const body = 'héllo 世界 🌍\n';
      writeFileSync(join(root, 'utf.txt'), body, 'utf-8');
      const res = await fb.read({ cwd: root, path: 'utf.txt' });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('text');
      expect(res.content).toBe(body);
      expect(res.encoding).toBe('utf-8');
    });
  });

  // -------------------------------------------------------------------------
  // read() — image branch (allowImage)
  // -------------------------------------------------------------------------
  describe('read() image branch', () => {
    // 1×1 transparent PNG.
    const PNG_BYTES = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=',
      'base64',
    );

    it('returns kind "image" with base64 content + mimeType when allowImage is true', async () => {
      writeFileSync(join(root, 'pixel.png'), PNG_BYTES);
      const res = await fb.read({ cwd: root, path: 'pixel.png', allowImage: true });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('image');
      expect(res.encoding).toBe('base64');
      expect(res.mimeType).toBe('image/png');
      expect(res.content).toBe(PNG_BYTES.toString('base64'));
    });

    it('detects mime type by extension (case-insensitive)', async () => {
      writeFileSync(join(root, 'pic.JPG'), PNG_BYTES); // bytes don't matter — mime is by extension
      const res = await fb.read({ cwd: root, path: 'pic.JPG', allowImage: true });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('image');
      expect(res.mimeType).toBe('image/jpeg');
    });

    it('falls through to binary path for non-image extensions even when allowImage is true', async () => {
      const buf = Buffer.from([0x00, 0x01, 0x02]);
      writeFileSync(join(root, 'blob.dat'), buf);
      const res = await fb.read({ cwd: root, path: 'blob.dat', allowImage: true });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('binary');
      expect(res.content).toBeUndefined();
    });

    it('without allowImage, image files still go through the binary path (unchanged default)', async () => {
      writeFileSync(join(root, 'pixel.png'), PNG_BYTES);
      const res = await fb.read({ cwd: root, path: 'pixel.png' });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('binary');
      expect(res.content).toBeUndefined();
    });

    it('image branch uses its own larger cap — files above the 512 KiB text cap still load', async () => {
      // 600 KiB of "PNG" — bytes don't matter, the image branch trusts the
      // extension and skips NUL sniffing.
      const big = Buffer.alloc(600 * 1024, 0x42);
      writeFileSync(join(root, 'big.png'), big);
      const res = await fb.read({ cwd: root, path: 'big.png', allowImage: true });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('image');
      expect(res.content!.length).toBeGreaterThan(0);
    });

    it('image branch enforces its own ceiling — files above 4 MiB return oversized', async () => {
      const huge = Buffer.alloc(5 * 1024 * 1024, 0x43); // 5 MiB
      writeFileSync(join(root, 'huge.png'), huge);
      const res = await fb.read({ cwd: root, path: 'huge.png', allowImage: true });
      expect(res.success).toBe(true);
      expect(res.kind).toBe('oversized');
      expect(res.content).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------
  describe('singleton', () => {
    it('getFileBrowser() returns the same instance across calls', () => {
      const a = getFileBrowser();
      const b = getFileBrowser();
      expect(a).toBe(b);
    });

    it('_resetFileBrowserForTest() causes the next getFileBrowser() call to return a fresh instance', () => {
      const a = getFileBrowser();
      _resetFileBrowserForTest();
      const b = getFileBrowser();
      expect(b).not.toBe(a);
    });
  });
});
