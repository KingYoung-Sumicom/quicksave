// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
// ============================================================================
// Lightweight PDF metadata reader. We don't need a full parser — just enough
// to enforce the Anthropic API's 100-page limit before a too-large PDF gets
// shipped to Claude (where the SDK rewrites the rejection as a "PDF too
// large" poison block, see claudeSdkProvider.ts POISON_PATTERNS).
//
// Approach: PDFs are mostly ASCII with binary streams between `stream` and
// `endstream` markers. Page objects are declared as `<< /Type /Page ... >>`
// (note: `/Pages` is the parent tree, not a leaf — must NOT match). We scan
// the raw bytes for `/Type /Page` while excluding `/Pages` via a negative
// lookahead.
//
// Limitations:
//  - Encrypted / linearized PDFs may produce a count of 0; the caller should
//    treat null/0 as "unknown" and let Claude be the authority.
//  - Object streams (PDF 1.5+) may compress page objects so the regex misses
//    them. In practice >99% of consumer PDFs leave page objects uncompressed.
//
// This is intentionally a permissive heuristic: false negatives (missing a
// page count) fall through to the recovery card path. False positives
// (counting too many pages) are rare and would only affect already-oversize
// PDFs the user shouldn't send anyway.
// ============================================================================

/**
 * Count `/Type /Page` page objects in a PDF buffer, returning null if the
 * buffer doesn't look like a PDF (no `%PDF-` header). A 0 return on a
 * valid-looking PDF means we couldn't find any uncompressed page objects —
 * caller should treat that the same as null (unknown).
 */
export function countPdfPages(buf: Buffer): number | null {
  if (buf.length < 8) return null;
  // Raw PDF header check; PDFs may have a small leading garbage prefix per
  // spec but the magic must appear in the first 1024 bytes.
  const head = buf.subarray(0, Math.min(buf.length, 1024)).toString('latin1');
  if (!head.includes('%PDF-')) return null;

  // latin1 is a 1-byte-per-char round-trip — safe for byte regex even when
  // streams contain non-UTF-8 bytes. Allow whitespace (space, tab, newlines)
  // between `/Type` and `/Page`. Reject `/Pages` (the catalog/tree node) via
  // a negative lookahead on the next char.
  const text = buf.toString('latin1');
  const re = /\/Type\s*\/Page(?![a-zA-Z])/g;
  let count = 0;
  while (re.exec(text) !== null) count++;
  return count;
}
