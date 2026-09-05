// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { createHash, webcrypto } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FilesRtcDataMessage } from '@sumicom/quicksave-shared';
import { assembleRtcFileResponse, readFileViaRtc } from './fileRtcClient';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      subtle: {
        digest(algorithm: AlgorithmIdentifier, data: BufferSource) {
          const view = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          return webcrypto.subtle.digest(algorithm, Buffer.from(Array.from(view)));
        },
      },
    },
  });
});

const header: Extract<FilesRtcDataMessage, { t: 'header' }> = {
  t: 'header',
  kind: 'text',
  cwd: '/work',
  path: 'large.txt',
  absolutePath: '/work/large.txt',
  size: 11,
  mtime: 123,
};

describe('assembleRtcFileResponse', () => {
  it('assembles ordered chunks and verifies SHA-256', async () => {
    const chunks = [new TextEncoder().encode('hello '), new TextEncoder().encode('world')];
    const sha256 = createHash('sha256').update('hello world').digest('hex');
    await expect(assembleRtcFileResponse(header, chunks, 11, {
      t: 'complete', bytes: 11, sha256,
    })).resolves.toMatchObject({
      success: true,
      kind: 'text',
      content: 'hello world',
      encoding: 'utf-8',
    });
  });

  it('rejects an incomplete transfer', async () => {
    await expect(assembleRtcFileResponse(header, [new Uint8Array([1])], 1, {
      t: 'complete', bytes: 1,
    })).rejects.toThrow('Incomplete file transfer');
  });

  it('assembles binary files as base64 for download', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await expect(assembleRtcFileResponse({ ...header, kind: 'binary', size: bytes.byteLength }, [bytes], bytes.byteLength, {
      t: 'complete', bytes: bytes.byteLength, sha256,
    })).resolves.toMatchObject({
      success: true,
      kind: 'binary',
      size: bytes.byteLength,
      content: 'AAEC/w==',
      encoding: 'base64',
    });
  });
});

describe('readFileViaRtc', () => {
  const OriginalPeerConnection = globalThis.RTCPeerConnection;
  afterEach(() => {
    Object.defineProperty(globalThis, 'RTCPeerConnection', {
      value: OriginalPeerConnection,
      configurable: true,
      writable: true,
    });
  });

  it('negotiates over the bus and receives file bytes only on the DataChannel', async () => {
    const body = new TextEncoder().encode('hello world');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const progress = vi.fn();

    class FakeDataChannel {
      binaryType = '';
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      close = vi.fn();
    }
    class FakePeerConnection {
      connectionState = 'connected';
      onconnectionstatechange: (() => void) | null = null;
      onicecandidate: ((event: { candidate: null }) => void) | null = null;
      dc = new FakeDataChannel();
      createDataChannel = vi.fn(() => this.dc);
      createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'offer-sdp' }));
      setLocalDescription = vi.fn(async () => {});
      setRemoteDescription = vi.fn(async () => {
        this.dc.onopen?.();
        this.dc.onmessage?.({ data: JSON.stringify(header) });
        this.dc.onmessage?.({ data: body });
        this.dc.onmessage?.({ data: JSON.stringify({ t: 'complete', bytes: body.byteLength, sha256 }) });
      });
      addIceCandidate = vi.fn(async () => {});
      close = vi.fn();
      constructor(_config: unknown) {}
    }
    Object.defineProperty(globalThis, 'RTCPeerConnection', {
      value: FakePeerConnection,
      configurable: true,
      writable: true,
    });

    const commands: string[] = [];
    const bus = {
      command: vi.fn(async (verb: string) => {
        commands.push(verb);
        return verb === 'files:rtc-connect' ? { sdp: 'answer-sdp' } : { ok: true };
      }),
      subscribe: vi.fn(() => () => {}),
    };
    const response = await readFileViaRtc(bus as never, { cwd: '/work', path: 'large.txt' }, {
      onProgress: progress,
    });

    expect(response).toMatchObject({ success: true, kind: 'text', content: 'hello world' });
    expect(commands).toContain('files:rtc-connect');
    expect(commands).toContain('files:rtc-cancel');
    expect(progress).toHaveBeenLastCalledWith({ receivedBytes: 11, totalBytes: 11 });
  });
});
