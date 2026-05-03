// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Attachment, AttachmentFetchRequestPayload } from '@sumicom/quicksave-shared';
import {
  readAttachmentWithCache,
  primeAttachment,
  invalidateSessionAttachments,
  _resetAttachmentCacheForTest,
  _attachmentL1StatsForTest,
} from './attachmentCache';

function makeAttachment(id: string, body: string): Attachment {
  return {
    id,
    kind: 'text',
    mimeType: 'text/plain',
    name: `${id}.txt`,
    size: body.length,
    data: btoa(body),
  };
}

describe('attachmentCache', () => {
  beforeEach(() => {
    _resetAttachmentCacheForTest();
  });

  it('reads from fetcher on miss, caches by sessionId+id on hit', async () => {
    const a = makeAttachment('a1', 'hello');
    const fetcher = vi.fn(async (_req: AttachmentFetchRequestPayload) => a);

    const r1 = await readAttachmentWithCache({ sessionId: 's1', attachmentId: 'a1' }, fetcher);
    const r2 = await readAttachmentWithCache({ sessionId: 's1', attachmentId: 'a1' }, fetcher);
    expect(r1).toBe(a);
    expect(r2).toBe(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('isolates cache by sessionId and by attachmentId', async () => {
    const a = makeAttachment('a1', 'A');
    const b = makeAttachment('a1', 'B'); // same id, different content (different session)
    const fetcher = vi.fn(async (req: AttachmentFetchRequestPayload) => (req.sessionId === 's1' ? a : b));

    const r1 = await readAttachmentWithCache({ sessionId: 's1', attachmentId: 'a1' }, fetcher);
    const r2 = await readAttachmentWithCache({ sessionId: 's2', attachmentId: 'a1' }, fetcher);
    expect(r1).toBe(a);
    expect(r2).toBe(b);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('primeAttachment populates the cache without a fetch', async () => {
    const a = makeAttachment('a1', 'pre');
    primeAttachment('s1', a);

    const fetcher = vi.fn(async () => makeAttachment('a1', 'never'));
    const result = await readAttachmentWithCache({ sessionId: 's1', attachmentId: 'a1' }, fetcher);
    expect(result).toEqual(a);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('invalidateSessionAttachments drops every entry for one session', async () => {
    primeAttachment('s1', makeAttachment('a', 'x'));
    primeAttachment('s1', makeAttachment('b', 'y'));
    primeAttachment('s2', makeAttachment('c', 'z'));

    expect(_attachmentL1StatsForTest().count).toBe(3);
    invalidateSessionAttachments('s1');
    expect(_attachmentL1StatsForTest().count).toBe(1);

    const fetcher = vi.fn(async (req: AttachmentFetchRequestPayload) => makeAttachment(req.attachmentId, '!'));
    // s2 still cached
    await readAttachmentWithCache({ sessionId: 's2', attachmentId: 'c' }, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    // s1 gone — re-fetches
    await readAttachmentWithCache({ sessionId: 's1', attachmentId: 'a' }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not cache fetcher errors', async () => {
    let attempt = 0;
    const fetcher = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('boom');
      return makeAttachment('a', 'ok');
    });

    await expect(readAttachmentWithCache({ sessionId: 's1', attachmentId: 'a' }, fetcher))
      .rejects.toThrow('boom');
    const ok = await readAttachmentWithCache({ sessionId: 's1', attachmentId: 'a' }, fetcher);
    expect(ok.data).toBe(btoa('ok'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
