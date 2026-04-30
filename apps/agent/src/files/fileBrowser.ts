// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * FileBrowser — read-only directory listings and text file previews.
 *
 * Path resolution rules:
 *   - Absolute `path` is used as-is (cwd is ignored — useful for clickable
 *     links pointing outside the project, e.g. /etc/hosts in a tool log).
 *   - Relative `path` is resolved against `cwd`; cwd is required in this
 *     case but no inside-root assertion is performed.
 *
 * No sandbox: the daemon already exposes a full PTY via `terminal:*`, so
 * clamping reads to a project root would be security theatre on the same
 * E2E channel. The trust boundary is the WebRTC peer pin, not the path.
 *
 * Binary files and files over a size cap return metadata only (kind tag
 * + size/mtime) so the PWA can render a placeholder instead of pulling
 * large buffers over the wire.
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
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
/** Larger ceiling when the caller opts in to image inlining (`allowImage`).
 *  base64 inflates by ~33%, so 4 MiB on the wire ≈ 3 MiB of source pixels. */
const HARD_IMAGE_BYTES = 4 * 1024 * 1024;
/** Bytes to sniff when classifying a file as text vs binary (NUL byte = binary). */
const SNIFF_BYTES = 8 * 1024;

/** Extensions we recognise for inline image rendering. SVG is text and is
 *  handled by the normal text path — it doesn't need base64. */
const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

function imageMimeFor(absPath: string): string | undefined {
  const dot = absPath.lastIndexOf('.');
  if (dot < 0) return undefined;
  return IMAGE_EXT_TO_MIME[absPath.slice(dot + 1).toLowerCase()];
}

export class FileBrowser {
  async list(payload: FilesListRequestPayload): Promise<FilesListResponsePayload> {
    try {
      const targetAbs = await resolveTarget(payload.cwd, payload.path);
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
      const targetAbs = await resolveTarget(payload.cwd, payload.path);
      const stats = await stat(targetAbs);
      if (!stats.isFile()) {
        return {
          success: false,
          cwd: payload.cwd,
          path: payload.path,
          error: 'Not a regular file',
        };
      }

      const meta = {
        cwd: payload.cwd,
        path: payload.path,
        absolutePath: targetAbs,
        size: stats.size,
        mtime: Math.floor(stats.mtimeMs),
      };

      // Image branch — opt-in via `allowImage`. We use a separate, larger
      // cap because images legitimately exceed the 100 KiB text preview
      // budget, but we still bound it so a stray multi-MB asset can't
      // saturate the channel.
      const imageMime = payload.allowImage ? imageMimeFor(targetAbs) : undefined;
      if (imageMime) {
        if (stats.size > HARD_IMAGE_BYTES) {
          return { success: true, ...meta, kind: 'oversized' };
        }
        const buf = await readFile(targetAbs);
        return {
          success: true,
          ...meta,
          kind: 'image',
          content: buf.toString('base64'),
          encoding: 'base64',
          mimeType: imageMime,
        };
      }

      const requested = payload.maxBytes ?? DEFAULT_PREVIEW_BYTES;
      const cap = Math.max(1, Math.min(requested, HARD_PREVIEW_BYTES));

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
 * Resolve `cwd + path` to an absolute path. No sandbox check — see module
 * docstring for the rationale.
 *
 *   - Absolute `path` is returned verbatim (cwd ignored).
 *   - Relative `path` is resolved against `realpath(cwd)`; cwd is required
 *     in this case. We canonicalise the root with `realpath` so symlinked
 *     project directories work, but resolve the child purely lexically so
 *     a non-existent target surfaces a readable error from `stat()`
 *     instead of failing inside `realpath`.
 */
async function resolveTarget(cwd: string, relPath: string): Promise<string> {
  if (relPath && isAbsolute(relPath)) return relPath;
  if (!cwd || typeof cwd !== 'string') {
    throw new Error('cwd is required when path is relative');
  }
  const rootAbs = await realpath(resolve(cwd));
  return resolve(rootAbs, relPath || '.');
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
