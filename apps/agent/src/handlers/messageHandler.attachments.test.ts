// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { MessageHandler } from './messageHandler.js';
import { createMessage } from '@sumicom/quicksave-shared';
import type {
  AttachmentUploadRequestPayload,
  AttachmentUploadResponsePayload,
  AttachmentCancelRequestPayload,
  AttachmentCancelResponsePayload,
  AttachmentFetchRequestPayload,
  AttachmentFetchResponsePayload,
  ErrorPayload,
} from '@sumicom/quicksave-shared';
import { persistAttachments } from '../ai/attachmentStore.js';
import { setQuicksaveDir } from '../service/singleton.js';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    addManagedRepo: vi.fn(),
    removeManagedRepo: vi.fn(),
    addManagedCodingPath: vi.fn(),
    removeManagedCodingPath: vi.fn(),
    getAnthropicApiKey: vi.fn(() => undefined),
    setAnthropicApiKey: vi.fn(),
    hasAnthropicApiKey: vi.fn(() => false),
  };
});

const PEER = 'peer-A';
const PEER_B = 'peer-B';

function uploadMsg(payload: AttachmentUploadRequestPayload) {
  return createMessage<AttachmentUploadRequestPayload>('attachment:upload', payload);
}
function cancelMsg(payload: AttachmentCancelRequestPayload) {
  return createMessage<AttachmentCancelRequestPayload>('attachment:cancel', payload);
}

describe('MessageHandler attachment verbs', () => {
  let handler: MessageHandler;
  let testQuicksaveDir: string;

  beforeEach(async () => {
    testQuicksaveDir = join(tmpdir(), `qs-att-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testQuicksaveDir, { recursive: true });
    setQuicksaveDir(testQuicksaveDir);
    handler = new MessageHandler([]);
  });

  afterEach(async () => {
    handler.cleanup();
    try {
      await rm(testQuicksaveDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('accepts a single-chunk upload and returns ready=true', async () => {
    const data = Buffer.from('hello world').toString('base64');
    const res = await handler.handleMessage(
      uploadMsg({
        attachmentId: 'a1',
        meta: {
          kind: 'text',
          mimeType: 'text/plain',
          name: 'pasted-1.txt',
          size: 11,
          totalChunks: 1,
        },
        chunkIndex: 0,
        chunk: data,
      }),
      PEER,
    );
    expect(res.type).toBe('attachment:upload:response');
    const payload = res.payload as AttachmentUploadResponsePayload;
    expect(payload.attachmentId).toBe('a1');
    expect(payload.ready).toBe(true);
    expect(payload.receivedBytes).toBe(11);
  });

  it('progress accumulates across multiple chunks', async () => {
    const part1 = Buffer.from('hello ');
    const part2 = Buffer.from('world');

    const r1 = await handler.handleMessage(
      uploadMsg({
        attachmentId: 'a2',
        meta: { kind: 'text', mimeType: 'text/plain', name: 'p.txt', size: 11, totalChunks: 2 },
        chunkIndex: 0,
        chunk: part1.toString('base64'),
      }),
      PEER,
    );
    expect((r1.payload as AttachmentUploadResponsePayload).ready).toBe(false);
    expect((r1.payload as AttachmentUploadResponsePayload).receivedBytes).toBe(6);

    const r2 = await handler.handleMessage(
      uploadMsg({ attachmentId: 'a2', chunkIndex: 1, chunk: part2.toString('base64') }),
      PEER,
    );
    expect((r2.payload as AttachmentUploadResponsePayload).ready).toBe(true);
    expect((r2.payload as AttachmentUploadResponsePayload).receivedBytes).toBe(11);
  });

  it('returns an error response (with code) on validation failure', async () => {
    const res = await handler.handleMessage(
      uploadMsg({
        attachmentId: 'too-big',
        meta: {
          kind: 'image',
          mimeType: 'image/png',
          name: 'huge.png',
          size: 100 * 1024 * 1024, // > 5 MB image limit
          totalChunks: 1,
        },
        chunkIndex: 0,
        chunk: 'AAAA',
      }),
      PEER,
    );
    expect(res.type).toBe('error');
    const err = res.payload as ErrorPayload;
    expect(err.code).toBe('attachment_too_large');
  });

  it('cancel returns removed=true for a known id, false otherwise', async () => {
    await handler.handleMessage(
      uploadMsg({
        attachmentId: 'c1',
        meta: { kind: 'text', mimeType: 'text/plain', name: 'p.txt', size: 1, totalChunks: 1 },
        chunkIndex: 0,
        chunk: Buffer.from('x').toString('base64'),
      }),
      PEER,
    );

    const r1 = await handler.handleMessage(cancelMsg({ attachmentId: 'c1' }), PEER);
    expect(r1.type).toBe('attachment:cancel:response');
    expect((r1.payload as AttachmentCancelResponsePayload).removed).toBe(true);

    const r2 = await handler.handleMessage(cancelMsg({ attachmentId: 'c1' }), PEER);
    expect((r2.payload as AttachmentCancelResponsePayload).removed).toBe(false);

    const r3 = await handler.handleMessage(cancelMsg({ attachmentId: 'never-staged' }), PEER);
    expect((r3.payload as AttachmentCancelResponsePayload).removed).toBe(false);
  });

  it('isolates staging per peer', async () => {
    await handler.handleMessage(
      uploadMsg({
        attachmentId: 'shared-id',
        meta: { kind: 'text', mimeType: 'text/plain', name: 'a.txt', size: 1, totalChunks: 1 },
        chunkIndex: 0,
        chunk: Buffer.from('a').toString('base64'),
      }),
      PEER,
    );

    // Peer B canceling shared-id finds nothing.
    const res = await handler.handleMessage(cancelMsg({ attachmentId: 'shared-id' }), PEER_B);
    expect((res.payload as AttachmentCancelResponsePayload).removed).toBe(false);

    // Peer A still has it.
    const stillThere = await handler.handleMessage(cancelMsg({ attachmentId: 'shared-id' }), PEER);
    expect((stillThere.payload as AttachmentCancelResponsePayload).removed).toBe(true);
  });

  it('removeClient drops all of a peer\'s staged attachments', async () => {
    await handler.handleMessage(
      uploadMsg({
        attachmentId: 'drop-me',
        meta: { kind: 'text', mimeType: 'text/plain', name: 'a.txt', size: 1, totalChunks: 1 },
        chunkIndex: 0,
        chunk: Buffer.from('a').toString('base64'),
      }),
      PEER,
    );
    handler.removeClient(PEER);
    const res = await handler.handleMessage(cancelMsg({ attachmentId: 'drop-me' }), PEER);
    expect((res.payload as AttachmentCancelResponsePayload).removed).toBe(false);
  });

  it('attachment:fetch returns a persisted attachment by sessionId + id', async () => {
    const data = Buffer.from('payload bytes', 'utf8').toString('base64');
    await persistAttachments('sess-fetch', [{
      id: 'fetch-me',
      kind: 'text',
      mimeType: 'text/plain',
      name: 'note.txt',
      size: 13,
      data,
    }]);

    const res = await handler.handleMessage(
      {
        id: 'm1',
        type: 'attachment:fetch',
        timestamp: Date.now(),
        payload: { sessionId: 'sess-fetch', attachmentId: 'fetch-me' } as AttachmentFetchRequestPayload,
      },
      PEER,
    );
    expect(res.type).toBe('attachment:fetch:response');
    const payload = res.payload as AttachmentFetchResponsePayload;
    expect(payload.attachment.id).toBe('fetch-me');
    expect(payload.attachment.name).toBe('note.txt');
    expect(Buffer.from(payload.attachment.data, 'base64').toString('utf8')).toBe('payload bytes');
  });

  it('attachment:fetch returns attachment_not_found for unknown ids', async () => {
    const res = await handler.handleMessage(
      {
        id: 'm2',
        type: 'attachment:fetch',
        timestamp: Date.now(),
        payload: { sessionId: 'nope', attachmentId: 'nope' } as AttachmentFetchRequestPayload,
      },
      PEER,
    );
    expect(res.type).toBe('error');
    expect((res.payload as ErrorPayload).code).toBe('attachment_not_found');
  });

  it('exposes staging so other paths can consume', async () => {
    const data = Buffer.from('payload').toString('base64');
    await handler.handleMessage(
      uploadMsg({
        attachmentId: 'consume-me',
        meta: { kind: 'text', mimeType: 'text/plain', name: 'a.txt', size: 7, totalChunks: 1 },
        chunkIndex: 0,
        chunk: data,
      }),
      PEER,
    );
    const staged = handler.getAttachmentStaging().consume(PEER, ['consume-me']);
    expect(staged).toHaveLength(1);
    expect(staged[0].id).toBe('consume-me');
    expect(staged[0].kind).toBe('text');
    expect(Buffer.from(staged[0].data, 'base64').toString('utf8')).toBe('payload');
  });
});
