// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  bytesToBase64,
  startUpload,
  cancelUpload,
  forgetUpload,
  useAttachmentUploadStore,
  type PendingAttachment,
} from './attachmentUploader';
import { ATTACHMENT_CHUNK_BYTES } from '@sumicom/quicksave-shared';

// Mock the bus registry — every test installs a fresh fake bus.
vi.mock('./busRegistry', () => ({
  getBusForAgent: (_agentId: string) => fakeBus,
}));

interface RecordedCommand {
  verb: string;
  payload: unknown;
}

let fakeBus: {
  command: (verb: string, payload: unknown, opts?: unknown) => Promise<unknown>;
} | null = null;
let recorded: RecordedCommand[] = [];

function makePending(id: string, bytes: Uint8Array): PendingAttachment {
  return {
    id,
    kind: 'text',
    mimeType: 'text/plain',
    name: `${id}.txt`,
    bytes,
    agentId: 'test-agent',
  };
}

/** Wait for the upload store to reach a status (or fail after `tries`). */
async function waitFor(id: string, predicate: (s: ReturnType<typeof useAttachmentUploadStore.getState>['uploads'][string]) => boolean) {
  for (let i = 0; i < 50; i++) {
    const s = useAttachmentUploadStore.getState().uploads[id];
    if (s && predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${id}`);
}

beforeEach(() => {
  recorded = [];
  // Reset the store between tests.
  useAttachmentUploadStore.setState({ uploads: {} });
});

describe('bytesToBase64', () => {
  it('round-trips ASCII', () => {
    const bytes = new TextEncoder().encode('hello world');
    expect(atob(bytesToBase64(bytes))).toBe('hello world');
  });
  it('round-trips binary > 32 KB chunk boundary', () => {
    const bytes = new Uint8Array(80_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const b64 = bytesToBase64(bytes);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
  it('handles empty input', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });
});

describe('startUpload — single chunk', () => {
  it('sends one upload command and reaches ready', async () => {
    fakeBus = {
      command: async (verb, payload) => {
        recorded.push({ verb, payload });
        return { attachmentId: (payload as { attachmentId: string }).attachmentId, receivedBytes: 5, ready: true };
      },
    };
    const bytes = new TextEncoder().encode('hello');
    startUpload(makePending('a1', bytes));

    await waitFor('a1', (s) => s.status === 'ready');
    expect(recorded).toHaveLength(1);
    const p = recorded[0].payload as { meta: unknown; chunkIndex: number };
    expect(recorded[0].verb).toBe('attachment:upload');
    expect(p.chunkIndex).toBe(0);
    expect(p.meta).toMatchObject({ kind: 'text', mimeType: 'text/plain', name: 'a1.txt', size: 5, totalChunks: 1 });

    const state = useAttachmentUploadStore.getState().uploads['a1'];
    expect(state.progress).toBe(1);
    expect(state.receivedBytes).toBe(5);
    expect(state.totalBytes).toBe(5);
  });
});

describe('startUpload — multi-chunk', () => {
  it('chunks bytes by ATTACHMENT_CHUNK_BYTES and serializes responses', async () => {
    const totalBytes = ATTACHMENT_CHUNK_BYTES * 2 + 100;
    const bytes = new Uint8Array(totalBytes);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    let bytesAcked = 0;
    fakeBus = {
      command: async (verb, payload) => {
        recorded.push({ verb, payload });
        const p = payload as { chunkIndex: number; chunk: string };
        const len = atob(p.chunk).length;
        bytesAcked += len;
        return {
          attachmentId: (payload as { attachmentId: string }).attachmentId,
          receivedBytes: bytesAcked,
          ready: bytesAcked === totalBytes,
        };
      },
    };
    startUpload(makePending('big', bytes));

    await waitFor('big', (s) => s.status === 'ready');
    expect(recorded.length).toBe(3); // 2 full + 1 trailing
    expect((recorded[0].payload as { chunkIndex: number }).chunkIndex).toBe(0);
    expect((recorded[1].payload as { chunkIndex: number }).chunkIndex).toBe(1);
    expect((recorded[2].payload as { chunkIndex: number }).chunkIndex).toBe(2);

    // Only first chunk carries meta.
    expect((recorded[0].payload as { meta?: unknown }).meta).toBeTruthy();
    expect((recorded[1].payload as { meta?: unknown }).meta).toBeUndefined();

    // Final chunk should hold the trailing 100 bytes.
    const lastBytes = atob((recorded[2].payload as { chunk: string }).chunk);
    expect(lastBytes.length).toBe(100);

    const state = useAttachmentUploadStore.getState().uploads['big'];
    expect(state.progress).toBe(1);
    expect(state.receivedBytes).toBe(totalBytes);
  });
});

describe('startUpload — error path', () => {
  it('marks the upload as error when the bus rejects', async () => {
    fakeBus = {
      command: async () => {
        throw new Error('attachment_too_large: image exceeds 5 MB');
      },
    };
    startUpload(makePending('bad', new Uint8Array([1, 2, 3])));

    const state = await waitFor('bad', (s) => s.status === 'error');
    expect(state.error).toContain('attachment_too_large');
  });

  it('marks error when no bus is connected', async () => {
    fakeBus = null;
    startUpload(makePending('off', new Uint8Array([1, 2, 3])));

    const state = await waitFor('off', (s) => s.status === 'error');
    expect(state.error).toBe('Not connected');
  });
});

describe('cancelUpload', () => {
  it('flips status to cancelled and stops further chunks', async () => {
    let cancelSent = false;
    fakeBus = {
      command: async (verb, payload) => {
        if (verb === 'attachment:cancel') {
          cancelSent = true;
          return { removed: true };
        }
        // Simulate slow response — chunk 0 hasn't returned yet when we cancel.
        await new Promise((r) => setTimeout(r, 30));
        return { attachmentId: (payload as { attachmentId: string }).attachmentId, receivedBytes: 1, ready: false };
      },
    };

    const bytes = new Uint8Array(ATTACHMENT_CHUNK_BYTES + 10);
    startUpload(makePending('cancel-me', bytes));
    // Give the first chunk a moment to start.
    await new Promise((r) => setTimeout(r, 5));
    await cancelUpload('cancel-me');

    expect(useAttachmentUploadStore.getState().uploads['cancel-me'].status).toBe('cancelled');
    expect(cancelSent).toBe(true);
  });
});

describe('forgetUpload', () => {
  it('clears the store entry', async () => {
    fakeBus = {
      command: async (_verb, payload) => ({
        attachmentId: (payload as { attachmentId: string }).attachmentId,
        receivedBytes: 1,
        ready: true,
      }),
    };
    startUpload(makePending('forget-me', new Uint8Array([1])));
    await waitFor('forget-me', (s) => s.status === 'ready');
    forgetUpload('forget-me');
    expect(useAttachmentUploadStore.getState().uploads['forget-me']).toBeUndefined();
  });
});
