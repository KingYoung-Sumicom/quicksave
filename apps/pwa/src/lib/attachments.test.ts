// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  fileToAttachment,
  attachmentsFromDataTransfer,
  inspectPaste,
  processPasteInspection,
  formatBytes,
  AttachmentRejectedError,
} from './attachments';

function makeFile(name: string, mime: string, body: Uint8Array | string): File {
  const data = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return new File([data], name, { type: mime });
}

// jsdom doesn't expose DataTransfer; build a minimal duck-typed stand-in.
function makeFakeDataTransfer(files: File[], text?: string): DataTransfer {
  const items = files.map((f) => ({
    kind: 'file' as const,
    type: f.type,
    getAsFile: () => f,
  }));
  const fileList = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () { for (const f of files) yield f; },
  } as unknown as FileList;
  return {
    files: fileList,
    items: items as unknown as DataTransferItemList,
    types: [...(text ? ['text/plain'] : []), ...(files.length > 0 ? ['Files'] : [])],
    getData: (k: string) => (k === 'text/plain' ? text ?? '' : ''),
  } as unknown as DataTransfer;
}

describe('fileToAttachment', () => {
  it('builds a PendingAttachment from a small image', async () => {
    const file = makeFile('a.png', 'image/png', new Uint8Array([1, 2, 3, 4]));
    const a = await fileToAttachment(file);
    expect(a.kind).toBe('image');
    expect(a.mimeType).toBe('image/png');
    expect(a.name).toBe('a.png');
    expect(a.bytes.byteLength).toBe(4);
    expect(a.id).toBeTruthy();
  });

  it('rejects empty files', async () => {
    await expect(fileToAttachment(makeFile('empty.txt', 'text/plain', '')))
      .rejects.toBeInstanceOf(AttachmentRejectedError);
  });

  it('rejects unsupported mime types', async () => {
    try {
      await fileToAttachment(makeFile('weird.bin', 'application/octet-stream', 'x'));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as AttachmentRejectedError).reason).toBe('unsupported_mime');
    }
  });

  it('rejects oversized images', async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    try {
      await fileToAttachment(makeFile('big.png', 'image/png', big));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as AttachmentRejectedError).reason).toBe('too_large');
    }
  });
});

describe('attachmentsFromDataTransfer', () => {
  it('returns empty for null DataTransfer', async () => {
    const r = await attachmentsFromDataTransfer(null, 0);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([]);
  });

  it('accepts allowed files and rejects unsupported ones', async () => {
    const dt = makeFakeDataTransfer([
      makeFile('img.png', 'image/png', new Uint8Array([1, 2, 3])),
      makeFile('weird.exe', 'application/octet-stream', 'x'),
    ]);
    const r = await attachmentsFromDataTransfer(dt, 0);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0].name).toBe('img.png');
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toBe('unsupported_mime');
  });

  it('respects per-message count cap', async () => {
    const dt = makeFakeDataTransfer([
      makeFile('a.png', 'image/png', new Uint8Array([1])),
      makeFile('b.png', 'image/png', new Uint8Array([2])),
      makeFile('c.png', 'image/png', new Uint8Array([3])),
    ]);
    const r = await attachmentsFromDataTransfer(dt, 4); // already 4, cap is 5
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected.every((x) => x.reason === 'too_many')).toBe(true);
  });
});

describe('inspectPaste + processPasteInspection', () => {
  it('short text → passthrough', async () => {
    const dt = makeFakeDataTransfer([], 'short paste');
    const inspection = inspectPaste(dt);
    expect(inspection.mode).toBe('passthrough');
    const r = await processPasteInspection(inspection, { existingCount: 0, pastedTextIndex: 1 });
    expect(r.accepted).toEqual([]);
  });

  it('long text → long-text inspection, processed into a kind:text attachment', async () => {
    const long = 'x'.repeat(2000);
    const dt = makeFakeDataTransfer([], long);
    const inspection = inspectPaste(dt);
    expect(inspection.mode).toBe('long-text');
    const r = await processPasteInspection(inspection, { existingCount: 0, pastedTextIndex: 1 });
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0].kind).toBe('text');
    expect(r.accepted[0].name).toBe('pasted-1.txt');
    expect(new TextDecoder().decode(r.accepted[0].bytes)).toBe(long);
  });

  it('file items → files inspection, processed via fileToAttachment', async () => {
    const file = makeFile('clip.png', 'image/png', new Uint8Array([1, 2]));
    const dt = makeFakeDataTransfer([file]);
    const inspection = inspectPaste(dt);
    expect(inspection.mode).toBe('files');
    const r = await processPasteInspection(inspection, { existingCount: 0, pastedTextIndex: 1 });
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0].kind).toBe('image');
  });

  it('long text exceeding the text limit → long-text-too-large; processor reports too_large', async () => {
    const huge = 'a'.repeat(300 * 1024);
    const dt = makeFakeDataTransfer([], huge);
    const inspection = inspectPaste(dt);
    expect(inspection.mode).toBe('long-text-too-large');
    const r = await processPasteInspection(inspection, { existingCount: 0, pastedTextIndex: 1 });
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toBe('too_large');
  });
});

describe('formatBytes', () => {
  it('formats < 1 KB as bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
  });
  it('formats KB', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
  it('formats MB', () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
