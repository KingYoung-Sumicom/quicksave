/**
 * FileBrowser — read-only directory listings and text file previews.
 *
 * Every request names a project root (`cwd`) and a relative path. The
 * agent resolves `cwd + path` against the canonical root and rejects
 * anything that escapes it, so the PWA can pass raw user input without
 * path-traversal risk.
 *
 * Binary files and files over a size cap return metadata only (kind tag
 * + size/mtime) so the PWA can render a placeholder instead of pulling
 * large buffers over the wire.
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { resolve, sep } from 'node:path';
import type {
  FileEntry,
  FileEntryKind,
  FilesListRequestPayload,
  FilesListResponsePayload,
  FilesReadRequestPayload,
  FilesReadResponsePayload,
} from '@sumicom/quicksave-shared';

/** Default preview cap — keeps frames small on mobile. */
const DEFAULT_PREVIEW_BYTES = 100 * 1024;
/** Absolute ceiling on `maxBytes` regardless of what the PWA asks for. */
const HARD_PREVIEW_BYTES = 512 * 1024;
/** Bytes to sniff when classifying a file as text vs binary (NUL byte = binary). */
const SNIFF_BYTES = 8 * 1024;

export class FileBrowser {
  async list(payload: FilesListRequestPayload): Promise<FilesListResponsePayload> {
    try {
      const { targetAbs } = await resolveWithinRoot(payload.cwd, payload.path);
      const stats = await stat(targetAbs);
      if (!stats.isDirectory()) {
        return {
          success: false,
          cwd: payload.cwd,
          path: payload.path,
          error: 'Not a directory',
        };
      }

      const dirents = await readdir(targetAbs, { withFileTypes: true });
      const entries = await Promise.all(
        dirents.map((d) => describeEntry(targetAbs, d)),
      );
      entries.sort(entrySort);

      return {
        success: true,
        cwd: payload.cwd,
        path: payload.path,
        absolutePath: targetAbs,
        entries,
      };
    } catch (err) {
      return {
        success: false,
        cwd: payload.cwd,
        path: payload.path,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async read(payload: FilesReadRequestPayload): Promise<FilesReadResponsePayload> {
    try {
      const { targetAbs } = await resolveWithinRoot(payload.cwd, payload.path);
      const stats = await stat(targetAbs);
      if (!stats.isFile()) {
        return {
          success: false,
          cwd: payload.cwd,
          path: payload.path,
          error: 'Not a regular file',
        };
      }

      const requested = payload.maxBytes ?? DEFAULT_PREVIEW_BYTES;
      const cap = Math.max(1, Math.min(requested, HARD_PREVIEW_BYTES));

      const meta = {
        cwd: payload.cwd,
        path: payload.path,
        absolutePath: targetAbs,
        size: stats.size,
        mtime: Math.floor(stats.mtimeMs),
      };

      if (stats.size > cap) {
        return { success: true, ...meta, kind: 'oversized' };
      }

      const buf = await readFile(targetAbs);
      if (isBinary(buf)) {
        return { success: true, ...meta, kind: 'binary' };
      }

      return {
        success: true,
        ...meta,
        kind: 'text',
        content: buf.toString('utf-8'),
        encoding: 'utf-8',
      };
    } catch (err) {
      return {
        success: false,
        cwd: payload.cwd,
        path: payload.path,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Resolve `cwd + path` to an absolute path and assert it stays under the
 * canonical root. We canonicalise the root with `realpath` so symlinked
 * project directories work, but we resolve the child purely lexically —
 * stat'ing a non-existent path surfaces a readable "no such file" error
 * instead of failing inside `realpath`.
 */
async function resolveWithinRoot(
  cwd: string,
  relPath: string,
): Promise<{ rootAbs: string; targetAbs: string }> {
  if (!cwd || typeof cwd !== 'string') throw new Error('cwd is required');
  const rootAbs = await realpath(resolve(cwd));
  const targetAbs = resolve(rootAbs, relPath || '.');
  if (!isInside(targetAbs, rootAbs)) {
    throw new Error('Path is outside project root');
  }
  return { rootAbs, targetAbs };
}

function isInside(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

async function describeEntry(dirAbs: string, dirent: Dirent): Promise<FileEntry> {
  const name = dirent.name;
  const full = resolve(dirAbs, name);
  // `stat` follows symlinks — we want target size/mtime for symlinks so the
  // UI shows meaningful numbers; fall back gracefully when the link is broken.
  const s = await stat(full).catch(() => null);
  if (!s) {
    return { name, kind: direntKind(dirent), size: 0, mtime: 0 };
  }
  const size = s.size;
  const mtime = Math.floor(s.mtimeMs);
  if (dirent.isSymbolicLink()) {
    return {
      name,
      kind: 'symlink',
      size,
      mtime,
      targetIsDirectory: s.isDirectory(),
    };
  }
  if (s.isDirectory()) {
    return { name, kind: 'directory', size: 0, mtime };
  }
  if (s.isFile()) {
    return { name, kind: 'file', size, mtime, oversized: size > DEFAULT_PREVIEW_BYTES };
  }
  return { name, kind: 'other', size, mtime };
}

function direntKind(d: Dirent): FileEntryKind {
  if (d.isDirectory()) return 'directory';
  if (d.isSymbolicLink()) return 'symlink';
  if (d.isFile()) return 'file';
  return 'other';
}

function entrySort(a: FileEntry, b: FileEntry): number {
  const rank = (k: FileEntryKind) => (k === 'directory' ? 0 : 1);
  const r = rank(a.kind) - rank(b.kind);
  if (r !== 0) return r;
  return a.name.localeCompare(b.name);
}

function isBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

let singleton: FileBrowser | null = null;

export function getFileBrowser(): FileBrowser {
  if (!singleton) singleton = new FileBrowser();
  return singleton;
}

export function _resetFileBrowserForTest(): void {
  singleton = null;
}
