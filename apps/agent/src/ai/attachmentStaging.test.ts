// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { AttachmentStaging } from './attachmentStaging.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function b64(s: string | Buffer): string {
  return (typeof s === 'string' ? Buffer.from(s) : s).toString('base64');
}

function expectThrowsCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected throw with code ${code}`);
}

const PEER_A = 'peer-a';
const PEER_B = 'peer-b';

const TEXT_META = (size: number, totalChunks: number) => ({
  kind: 'text' as const,
  mimeType: 'text/plain',
  name: 'note.txt',
  size,
  totalChunks,
});

// ── Happy path ─────────────────────────────────────────────────────────────

describe('AttachmentStaging — happy path', () => {
  it('single-chunk upload becomes ready and consume returns the original base64', () => {
    const s = new AttachmentStaging();
    const data = Buffer.from('hello world');
    const chunk = b64(data);

    const resp = s.acceptChunk(PEER_A, {
      attachmentId: 'a1',
      chunkIndex: 0,
      chunk,
      meta: TEXT_META(data.length, 1),
    });
    expect(resp).toEqual({ attachmentId: 'a1', receivedBytes: data.length, ready: true });

    const [att] = s.consume(PEER_A, ['a1']);
    expect(att.id).toBe('a1');
    expect(att.kind).toBe('text');
    expect(att.mimeType).toBe('text/plain');
    expect(att.name).toBe('note.txt');
    expect(att.size).toBe(data.length);
    expect(att.data).toBe(chunk);

    // Second consume of the same id throws attachment_not_found.
    expectThrowsCode(() => s.consume(PEER_A, ['a1']), 'attachment_not_found');
  });

  it('multi-chunk upload reports ready=false until last chunk and concatenates correctly', () => {
    const s = new AttachmentStaging();
    const part0 = Buffer.from('foo');
    const part1 = Buffer.from('bar');
    const part2 = Buffer.from('baz');
    const total = part0.length + part1.length + part2.length;
    const fullExpected = Buffer.concat([part0, part1, part2]).toString('base64');

    const r0 = s.acceptChunk(PEER_A, {
      attachmentId: 'm1',
      chunkIndex: 0,
      chunk: b64(part0),
      meta: TEXT_META(total, 3),
    });
    expect(r0).toEqual({ attachmentId: 'm1', receivedBytes: 3, ready: false });

    const r1 = s.acceptChunk(PEER_A, {
      attachmentId: 'm1',
      chunkIndex: 1,
      chunk: b64(part1),
    });
    expect(r1).toEqual({ attachmentId: 'm1', receivedBytes: 6, ready: false });

    const r2 = s.acceptChunk(PEER_A, {
      attachmentId: 'm1',
      chunkIndex: 2,
      chunk: b64(part2),
    });
    expect(r2).toEqual({ attachmentId: 'm1', receivedBytes: 9, ready: true });

    const [att] = s.consume(PEER_A, ['m1']);
    expect(att.data).toBe(fullExpected);
  });

  it('out-of-order chunks reassemble correctly', () => {
    const s = new AttachmentStaging();
    const part0 = Buffer.from('AAAA');
    const part1 = Buffer.from('BBBB');
    const part2 = Buffer.from('CCCC');
    const total = part0.length + part1.length + part2.length;
    const fullExpected = Buffer.concat([part0, part1, part2]).toString('base64');

    s.acceptChunk(PEER_A, {
      attachmentId: 'oo',
      chunkIndex: 0,
      chunk: b64(part0),
      meta: TEXT_META(total, 3),
    });
    s.acceptChunk(PEER_A, { attachmentId: 'oo', chunkIndex: 2, chunk: b64(part2) });
    const final = s.acceptChunk(PEER_A, { attachmentId: 'oo', chunkIndex: 1, chunk: b64(part1) });
    expect(final.ready).toBe(true);

    const [att] = s.consume(PEER_A, ['oo']);
    expect(att.data).toBe(fullExpected);
  });

  it('multiple attachments for one peer stage and consume independently', () => {
    const s = new AttachmentStaging();
    const da = Buffer.from('alpha');
    const db = Buffer.from('beta!!');

    s.acceptChunk(PEER_A, {
      attachmentId: 'a',
      chunkIndex: 0,
      chunk: b64(da),
      meta: TEXT_META(da.length, 1),
    });
    s.acceptChunk(PEER_A, {
      attachmentId: 'b',
      chunkIndex: 0,
      chunk: b64(db),
      meta: TEXT_META(db.length, 1),
    });

    expect(s.size(PEER_A)).toBe(2);

    const [attA] = s.consume(PEER_A, ['a']);
    expect(attA.data).toBe(b64(da));
    expect(s.size(PEER_A)).toBe(1);

    const [attB] = s.consume(PEER_A, ['b']);
    expect(attB.data).toBe(b64(db));
    expect(s.size(PEER_A)).toBe(0);
  });

  it('different peers are isolated (same attachmentId does not collide)', () => {
    const s = new AttachmentStaging();
    const dataA = Buffer.from('peer-a-data');
    const dataB = Buffer.from('peer-b-bytes');

    s.acceptChunk(PEER_A, {
      attachmentId: 'shared-id',
      chunkIndex: 0,
      chunk: b64(dataA),
      meta: TEXT_META(dataA.length, 1),
    });
    s.acceptChunk(PEER_B, {
      attachmentId: 'shared-id',
      chunkIndex: 0,
      chunk: b64(dataB),
      meta: TEXT_META(dataB.length, 1),
    });

    expect(s.size(PEER_A)).toBe(1);
    expect(s.size(PEER_B)).toBe(1);

    const [fromA] = s.consume(PEER_A, ['shared-id']);
    expect(fromA.data).toBe(b64(dataA));
    // Peer B still has its copy.
    expect(s.size(PEER_B)).toBe(1);
    const [fromB] = s.consume(PEER_B, ['shared-id']);
    expect(fromB.data).toBe(b64(dataB));
  });
});

// ── Idempotent re-send ─────────────────────────────────────────────────────

describe('AttachmentStaging — idempotent re-send', () => {
  it('re-sending the same chunk with identical bytes is a no-op', () => {
    const s = new AttachmentStaging();
    const part0 = Buffer.from('xx');
    const part1 = Buffer.from('yy');
    const total = part0.length + part1.length;

    s.acceptChunk(PEER_A, {
      attachmentId: 'idem',
      chunkIndex: 0,
      chunk: b64(part0),
      meta: TEXT_META(total, 2),
    });
    // Re-send chunk 0 with identical bytes — must not double-count.
    const resend = s.acceptChunk(PEER_A, {
      attachmentId: 'idem',
      chunkIndex: 0,
      chunk: b64(part0),
    });
    expect(resend).toEqual({ attachmentId: 'idem', receivedBytes: 2, ready: false });

    const final = s.acceptChunk(PEER_A, {
      attachmentId: 'idem',
      chunkIndex: 1,
      chunk: b64(part1),
    });
    expect(final).toEqual({ attachmentId: 'idem', receivedBytes: total, ready: true });

    const [att] = s.consume(PEER_A, ['idem']);
    expect(att.data).toBe(Buffer.concat([part0, part1]).toString('base64'));
  });

  it('re-sending the same chunkIndex with different bytes throws attachment_bad_request', () => {
    const s = new AttachmentStaging();
    const part0 = Buffer.from('xx');
    const total = 4;

    s.acceptChunk(PEER_A, {
      attachmentId: 'mismatch',
      chunkIndex: 0,
      chunk: b64(part0),
      meta: TEXT_META(total, 2),
    });

    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: 'mismatch',
          chunkIndex: 0,
          chunk: b64(Buffer.from('zz')),
        }),
      'attachment_bad_request',
    );
  });
});

// ── Validation errors ──────────────────────────────────────────────────────

describe('AttachmentStaging — validation errors', () => {
  it('unsafe attachmentId path segment throws attachment_bad_request', () => {
    const s = new AttachmentStaging();
    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: '../escape',
          chunkIndex: 0,
          chunk: b64('hi'),
          meta: TEXT_META(2, 1),
        }),
      'attachment_bad_request',
    );
  });

  it('first chunk without meta throws attachment_bad_request', () => {
    const s = new AttachmentStaging();
    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: 'no-meta',
          chunkIndex: 0,
          chunk: b64('hi'),
        }),
      'attachment_bad_request',
    );
  });

  it('meta.size exceeding ATTACHMENT_LIMITS for kind throws attachment_too_large', () => {
    const s = new AttachmentStaging();
    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: 'huge',
          chunkIndex: 0,
          chunk: b64('x'),
          meta: {
            kind: 'image',
            mimeType: 'image/png',
            name: 'big.png',
            size: 6 * 1024 * 1024, // image limit is 5 MB
            totalChunks: 1,
          },
        }),
      'attachment_too_large',
    );
  });

  it('non-integer chunkIndex throws attachment_bad_request', () => {
    const s = new AttachmentStaging();
    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: 'fl',
          chunkIndex: 1.5,
          chunk: b64('x'),
          meta: TEXT_META(10, 2),
        }),
      'attachment_bad_request',
    );
  });

  it('negative chunkIndex throws attachment_bad_request', () => {
    const s = new AttachmentStaging();
    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: 'neg',
          chunkIndex: -1,
          chunk: b64('x'),
          meta: TEXT_META(10, 2),
        }),
      'attachment_bad_request',
    );
  });

  it('chunkIndex >= totalChunks throws attachment_bad_request', () => {
    const s = new AttachmentStaging();
    // Stage with totalChunks: 2, then push chunkIndex 2.
    s.acceptChunk(PEER_A, {
      attachmentId: 'ovr',
      chunkIndex: 0,
      chunk: b64('aa'),
      meta: TEXT_META(4, 2),
    });
    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: 'ovr',
          chunkIndex: 2,
          chunk: b64('bb'),
        }),
      'attachment_bad_request',
    );
  });

  it('meta on later chunk that mismatches the original throws attachment_bad_request', () => {
    const s = new AttachmentStaging();
    s.acceptChunk(PEER_A, {
      attachmentId: 'mm',
      chunkIndex: 0,
      chunk: b64('aa'),
      meta: TEXT_META(4, 2),
    });
    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: 'mm',
          chunkIndex: 1,
          chunk: b64('bb'),
          meta: TEXT_META(99, 2), // different size
        }),
      'attachment_bad_request',
    );
  });

  it('chunk that pushes receivedBytes over declared size throws attachment_too_large', () => {
    const s = new AttachmentStaging();
    s.acceptChunk(PEER_A, {
      attachmentId: 'over',
      chunkIndex: 0,
      chunk: b64('aaaa'),
      meta: TEXT_META(5, 2),
    });
    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: 'over',
          chunkIndex: 1,
          chunk: b64('bbbb'), // 4 + 4 = 8 > 5
        }),
      'attachment_too_large',
    );
  });

  it('final chunk with mismatched total receivedBytes throws and removes the entry', () => {
    const s = new AttachmentStaging();
    // Declare size=10, totalChunks=2. First chunk 4 bytes, second chunk 4 bytes
    // (sum = 8, less than declared 10). The second chunk completes the count
    // but byte total mismatches → throw + drop.
    s.acceptChunk(PEER_A, {
      attachmentId: 'short',
      chunkIndex: 0,
      chunk: b64('aaaa'),
      meta: TEXT_META(10, 2),
    });
    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: 'short',
          chunkIndex: 1,
          chunk: b64('bbbb'),
        }),
      'attachment_bad_request',
    );
    // Entry must have been dropped.
    expectThrowsCode(() => s.consume(PEER_A, ['short']), 'attachment_not_found');
  });

  it('per-peer cap rejects with attachment_peer_quota and leaves prior record intact', () => {
    const s = new AttachmentStaging({ perPeerMaxBytes: 1024 });
    const six = Buffer.alloc(600, 0x41); // 600 bytes of 'A'

    // Stage the first 600 bytes — fits.
    const ok = s.acceptChunk(PEER_A, {
      attachmentId: 'first',
      chunkIndex: 0,
      chunk: b64(six),
      meta: TEXT_META(six.length, 1),
    });
    expect(ok.ready).toBe(true);
    expect(s.bytesFor(PEER_A)).toBe(600);

    // Attempt to stage another 600 bytes — would put us at 1200 > 1024.
    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: 'second',
          chunkIndex: 0,
          chunk: b64(six),
          meta: TEXT_META(six.length, 1),
        }),
      'attachment_peer_quota',
    );

    // First record must still be intact and consumable.
    expect(s.bytesFor(PEER_A)).toBe(600);
    const [att] = s.consume(PEER_A, ['first']);
    expect(att.size).toBe(600);
    expect(att.data).toBe(b64(six));
  });
});

// ── PDF page-count check ───────────────────────────────────────────────────

describe('AttachmentStaging — PDF page-count check', () => {
  /** Build a minimal PDF byte buffer with `pageCount` page objects. */
  function fakePdf(pageCount: number): Buffer {
    const pages = Array.from({ length: pageCount },
      (_, i) => `${i + 1} 0 obj\n<< /Type /Page /Parent 0 0 R >>\nendobj\n`,
    ).join('');
    return Buffer.from(`%PDF-1.7\n${pages}%%EOF\n`, 'latin1');
  }

  const PDF_META = (size: number, totalChunks: number) => ({
    kind: 'pdf' as const,
    mimeType: 'application/pdf',
    name: 'doc.pdf',
    size,
    totalChunks,
  });

  it('accepts a PDF with page count <= PDF_MAX_PAGES (100)', () => {
    const s = new AttachmentStaging();
    const pdf = fakePdf(50);
    const resp = s.acceptChunk(PEER_A, {
      attachmentId: 'p-ok',
      chunkIndex: 0,
      chunk: b64(pdf),
      meta: PDF_META(pdf.length, 1),
    });
    expect(resp.ready).toBe(true);
    const [att] = s.consume(PEER_A, ['p-ok']);
    expect(att.kind).toBe('pdf');
  });

  it('rejects a PDF with > PDF_MAX_PAGES on completion (drops the entry)', () => {
    const s = new AttachmentStaging();
    const pdf = fakePdf(150);
    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: 'p-too-many',
          chunkIndex: 0,
          chunk: b64(pdf),
          meta: PDF_META(pdf.length, 1),
        }),
      'attachment_too_many_pages',
    );
    // Entry must have been dropped so consume sees nothing.
    expectThrowsCode(() => s.consume(PEER_A, ['p-too-many']), 'attachment_not_found');
    // Running peer byte total must be released.
    expect(s.bytesFor(PEER_A)).toBe(0);
  });

  it('does NOT trigger the page check on a non-PDF kind (text upload with /Type /Page in body)', () => {
    const s = new AttachmentStaging();
    // A text file that happens to contain hundreds of "/Type /Page" — must
    // not trip the PDF page check because the kind is 'text'.
    const decoy = '/Type /Page\n'.repeat(200);
    const buf = Buffer.from(decoy, 'utf-8');
    const resp = s.acceptChunk(PEER_A, {
      attachmentId: 't-decoy',
      chunkIndex: 0,
      chunk: b64(buf),
      meta: { kind: 'text', mimeType: 'text/plain', name: 'note.txt', size: buf.length, totalChunks: 1 },
    });
    expect(resp.ready).toBe(true);
  });

  it('lets a PDF through when the page count cannot be determined (object-stream-compressed)', () => {
    const s = new AttachmentStaging();
    // %PDF- header but no /Type /Page in raw bytes — countPdfPages returns 0,
    // so we let it through and rely on the recovery card if Claude rejects.
    const buf = Buffer.from('%PDF-1.5\n<<binary stream>>\n%%EOF\n', 'latin1');
    const resp = s.acceptChunk(PEER_A, {
      attachmentId: 'p-opaque',
      chunkIndex: 0,
      chunk: b64(buf),
      meta: PDF_META(buf.length, 1),
    });
    expect(resp.ready).toBe(true);
  });

  it('runs the page check only on the final chunk, not on partial uploads', () => {
    const s = new AttachmentStaging();
    const pdf = fakePdf(150);
    // Split in two — first chunk should not trigger the check.
    const half = Math.floor(pdf.length / 2);
    const part0 = pdf.subarray(0, half);
    const part1 = pdf.subarray(half);

    const r0 = s.acceptChunk(PEER_A, {
      attachmentId: 'p-split',
      chunkIndex: 0,
      chunk: b64(part0),
      meta: PDF_META(pdf.length, 2),
    });
    expect(r0.ready).toBe(false);
    // No throw on the partial — record still alive.
    expect(s.size(PEER_A)).toBe(1);

    // Second (final) chunk completes and triggers the check.
    expectThrowsCode(
      () =>
        s.acceptChunk(PEER_A, {
          attachmentId: 'p-split',
          chunkIndex: 1,
          chunk: b64(part1),
        }),
      'attachment_too_many_pages',
    );
    expect(s.size(PEER_A)).toBe(0);
  });
});

// ── consume() invariants ───────────────────────────────────────────────────

describe('AttachmentStaging — consume() invariants', () => {
  it('throws attachment_not_ready for partial b but keeps a intact (atomic-or-nothing)', () => {
    const s = new AttachmentStaging();
    // a is fully ready (1 chunk).
    s.acceptChunk(PEER_A, {
      attachmentId: 'a',
      chunkIndex: 0,
      chunk: b64('xy'),
      meta: TEXT_META(2, 1),
    });
    // b is staged but only chunk 0 of 2 received.
    s.acceptChunk(PEER_A, {
      attachmentId: 'b',
      chunkIndex: 0,
      chunk: b64('zz'),
      meta: TEXT_META(4, 2),
    });

    expectThrowsCode(() => s.consume(PEER_A, ['a', 'b']), 'attachment_not_ready');

    // a must still be present.
    const [att] = s.consume(PEER_A, ['a']);
    expect(att.id).toBe('a');
  });

  it('throws attachment_not_found for missing b but keeps a intact', () => {
    const s = new AttachmentStaging();
    s.acceptChunk(PEER_A, {
      attachmentId: 'a',
      chunkIndex: 0,
      chunk: b64('xy'),
      meta: TEXT_META(2, 1),
    });

    expectThrowsCode(() => s.consume(PEER_A, ['a', 'b']), 'attachment_not_found');

    const [att] = s.consume(PEER_A, ['a']);
    expect(att.id).toBe('a');
  });

  it('consume([]) returns [] and does not throw', () => {
    const s = new AttachmentStaging();
    expect(s.consume(PEER_A, [])).toEqual([]);
    // Even when the peer has nothing staged at all.
    expect(s.consume('nobody', [])).toEqual([]);
  });
});

// ── cancel() / removePeer() ────────────────────────────────────────────────

describe('AttachmentStaging — cancel / removePeer', () => {
  it('cancel returns true for existing id and false for missing id', () => {
    const s = new AttachmentStaging();
    s.acceptChunk(PEER_A, {
      attachmentId: 'c1',
      chunkIndex: 0,
      chunk: b64('xy'),
      meta: TEXT_META(2, 1),
    });
    expect(s.cancel(PEER_A, 'c1')).toBe(true);
    expect(s.cancel(PEER_A, 'c1')).toBe(false);
    expect(s.cancel(PEER_A, 'never-staged')).toBe(false);

    expectThrowsCode(() => s.consume(PEER_A, ['c1']), 'attachment_not_found');
  });

  it('cancel frees bytes from the per-peer running total', () => {
    const s = new AttachmentStaging();
    const data = Buffer.alloc(123, 0x42);
    s.acceptChunk(PEER_A, {
      attachmentId: 'c2',
      chunkIndex: 0,
      chunk: b64(data),
      meta: TEXT_META(data.length, 1),
    });
    expect(s.bytesFor(PEER_A)).toBe(123);
    expect(s.cancel(PEER_A, 'c2')).toBe(true);
    expect(s.bytesFor(PEER_A)).toBe(0);
  });

  it('removePeer drops every record for that peer and zeros bytes; other peers untouched', () => {
    const s = new AttachmentStaging();
    s.acceptChunk(PEER_A, {
      attachmentId: 'a1',
      chunkIndex: 0,
      chunk: b64('aa'),
      meta: TEXT_META(2, 1),
    });
    s.acceptChunk(PEER_A, {
      attachmentId: 'a2',
      chunkIndex: 0,
      chunk: b64('bb'),
      meta: TEXT_META(2, 1),
    });
    s.acceptChunk(PEER_B, {
      attachmentId: 'b1',
      chunkIndex: 0,
      chunk: b64('cc'),
      meta: TEXT_META(2, 1),
    });

    expect(s.size(PEER_A)).toBe(2);
    expect(s.size(PEER_B)).toBe(1);

    s.removePeer(PEER_A);

    expect(s.size(PEER_A)).toBe(0);
    expect(s.bytesFor(PEER_A)).toBe(0);
    expectThrowsCode(() => s.consume(PEER_A, ['a1']), 'attachment_not_found');

    // Peer B still has its record.
    expect(s.size(PEER_B)).toBe(1);
    const [att] = s.consume(PEER_B, ['b1']);
    expect(att.id).toBe('b1');
  });
});

// ── gc() with TTL ──────────────────────────────────────────────────────────

describe('AttachmentStaging — gc / TTL', () => {
  it('keeps fresh records and drops stale ones; cleans peer maps', () => {
    let fakeTime = 0;
    const s = new AttachmentStaging({ ttlMs: 1000, now: () => fakeTime });

    s.acceptChunk(PEER_A, {
      attachmentId: 'g1',
      chunkIndex: 0,
      chunk: b64('xy'),
      meta: TEXT_META(2, 1),
    });
    expect(s.size(PEER_A)).toBe(1);
    expect(s.bytesFor(PEER_A)).toBe(2);

    // 500 ms later — still fresh.
    fakeTime = 500;
    s.gc();
    expect(s.size(PEER_A)).toBe(1);

    // 1500 ms after staging — stale.
    fakeTime = 1500;
    s.gc();
    expect(s.size(PEER_A)).toBe(0);
    expect(s.bytesFor(PEER_A)).toBe(0);
    expectThrowsCode(() => s.consume(PEER_A, ['g1']), 'attachment_not_found');

    // A fresh accept after gc starts the byte counter from 0.
    s.acceptChunk(PEER_A, {
      attachmentId: 'g2',
      chunkIndex: 0,
      chunk: b64('zzz'),
      meta: TEXT_META(3, 1),
    });
    expect(s.bytesFor(PEER_A)).toBe(3);
  });
});

// ── Diagnostics ────────────────────────────────────────────────────────────

describe('AttachmentStaging — diagnostics', () => {
  it('size() reports number of staged records and bytesFor() reports running total', () => {
    const s = new AttachmentStaging();

    expect(s.size(PEER_A)).toBe(0);
    expect(s.bytesFor(PEER_A)).toBe(0);

    // Ready single-chunk record (declared size 5 == received 5).
    s.acceptChunk(PEER_A, {
      attachmentId: 'd1',
      chunkIndex: 0,
      chunk: b64('hello'),
      meta: TEXT_META(5, 1),
    });
    expect(s.size(PEER_A)).toBe(1);
    expect(s.bytesFor(PEER_A)).toBe(5);

    // Partial record: declared 10, only 4 bytes received so far.
    s.acceptChunk(PEER_A, {
      attachmentId: 'd2',
      chunkIndex: 0,
      chunk: b64('aaaa'),
      meta: TEXT_META(10, 2),
    });
    expect(s.size(PEER_A)).toBe(2);
    // Sum: 5 (ready) + 4 (received-so-far for partial) = 9.
    expect(s.bytesFor(PEER_A)).toBe(9);
  });
});
