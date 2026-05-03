// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { countPdfPages } from './pdfMeta.js';

/** Build a tiny PDF-like buffer with N `/Type /Page` markers and a `/Pages`
 *  parent node. Not a real, parseable PDF — just shaped enough to exercise
 *  the regex scanner. */
function fakePdf(pageCount: number, opts: { withParent?: boolean; whitespace?: string } = {}): Buffer {
  const ws = opts.whitespace ?? ' ';
  const pages = Array.from({ length: pageCount },
    (_, i) => `${i + 1} 0 obj\n<< /Type${ws}/Page /Parent 0 0 R >>\nendobj\n`,
  ).join('');
  const parent = opts.withParent !== false
    ? `0 0 obj\n<< /Type /Pages /Kids [] /Count ${pageCount} >>\nendobj\n`
    : '';
  return Buffer.from(`%PDF-1.7\n${parent}${pages}%%EOF\n`, 'latin1');
}

describe('countPdfPages', () => {
  it('returns null for a buffer that is not a PDF', () => {
    expect(countPdfPages(Buffer.from('not a pdf, just some text'))).toBeNull();
  });

  it('returns null for an empty / tiny buffer', () => {
    expect(countPdfPages(Buffer.alloc(0))).toBeNull();
    expect(countPdfPages(Buffer.from('abc'))).toBeNull();
  });

  it('counts a single page', () => {
    expect(countPdfPages(fakePdf(1))).toBe(1);
  });

  it('counts many pages', () => {
    expect(countPdfPages(fakePdf(42))).toBe(42);
    expect(countPdfPages(fakePdf(150))).toBe(150);
  });

  it('does NOT count the /Pages parent node as a page', () => {
    const buf = fakePdf(3, { withParent: true });
    // 3 page leaves + 1 /Pages parent → must still be 3
    expect(countPdfPages(buf)).toBe(3);
  });

  it('tolerates varied whitespace between /Type and /Page', () => {
    expect(countPdfPages(fakePdf(2, { whitespace: '\t' }))).toBe(2);
    expect(countPdfPages(fakePdf(2, { whitespace: '\n' }))).toBe(2);
    expect(countPdfPages(fakePdf(2, { whitespace: '   ' }))).toBe(2);
  });

  it('does not match /PageLabels, /PageLayout, /Pagination, etc.', () => {
    const buf = Buffer.from(
      '%PDF-1.7\n'
      + '0 0 obj << /Type /PageLabels /Nums [] >> endobj\n'
      + '1 0 obj << /Type /PageLayout >> endobj\n'
      + '2 0 obj << /Type /Pagination >> endobj\n'
      + '%%EOF\n',
      'latin1',
    );
    expect(countPdfPages(buf)).toBe(0);
  });

  it('returns 0 for a PDF whose page objects live in compressed object streams (best-effort heuristic)', () => {
    // This shape has %PDF- header but no `/Type /Page` markers in the raw
    // bytes — typical of object-stream-compressed PDFs (PDF 1.5+).
    const buf = Buffer.from('%PDF-1.5\n<<binary stream contents>>\n%%EOF\n', 'latin1');
    expect(countPdfPages(buf)).toBe(0);
  });
});
