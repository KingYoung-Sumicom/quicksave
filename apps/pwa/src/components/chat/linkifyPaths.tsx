// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';
import { FilePathLink } from './FilePathLink';

/**
 * Splits a text blob into a mix of plain strings and clickable
 * `<FilePathLink>` nodes for any token that looks like a file path.
 *
 * Detection rules (deliberately conservative — false positives go to a
 * read endpoint that just errors, but false-positive linking on every
 * `2/3` fraction would look terrible):
 *
 *   - Absolute paths: `/foo/bar` (`/` followed by a non-`/` char). The
 *     `(?<!:)` guard skips matches inside `://` URLs.
 *   - Relative paths: at least one `dir/` segment plus a final piece —
 *     e.g. `apps/agent/src/foo.ts`. Single tokens like `foo.ts` are NOT
 *     matched (too noisy in normal prose).
 *   - Trailing `:line[:col]` is captured separately — the link only
 *     opens the file, not the line. Future extension: pass line to the
 *     modal for scroll-to-line.
 */
const PATH_RE = /(?<![:\w])(\/[\w@.~-][\w./@~-]*|(?:[\w@~.-]+\/)+[\w./@~-]+)(?::(\d+)(?::(\d+))?)?/g;

export function linkifyPaths(text: string): ReactNode[] {
  if (!text) return [];
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const m of text.matchAll(PATH_RE)) {
    const fullMatch = m[0];
    const pathPart = m[1];
    const start = m.index ?? 0;
    if (start > cursor) out.push(text.slice(cursor, start));
    out.push(
      <FilePathLink
        key={`${start}-${fullMatch}`}
        path={pathPart}
        className="inline-block align-baseline text-blue-400 hover:text-blue-300 font-bold underline transition-colors font-mono"
      >
        {fullMatch}
      </FilePathLink>,
    );
    cursor = start + fullMatch.length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out.length === 0 ? [text] : out;
}
