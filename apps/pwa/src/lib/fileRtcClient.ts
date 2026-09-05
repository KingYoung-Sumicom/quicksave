// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/** Browser-side direct large-file receiver. */
import type {
  FilesReadRequestPayload,
  FilesReadResponsePayload,
  FilesRtcConnectRequestPayload,
  FilesRtcConnectResponsePayload,
  FilesRtcDataMessage,
  FilesRtcIceRequestPayload,
  FilesRtcIceUpdate,
} from '@sumicom/quicksave-shared';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';

const STUN_URL = 'stun:stun.l.google.com:19302';
const CONNECT_TIMEOUT_MS = 10_000;
const TRANSFER_TIMEOUT_MS = 90_000;

export interface FileRtcProgress {
  receivedBytes: number;
  totalBytes: number;
}

export interface FileRtcReadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: FileRtcProgress) => void;
}

export async function readFileViaRtc(
  bus: MessageBusClient,
  request: FilesReadRequestPayload,
  options: FileRtcReadOptions = {},
): Promise<FilesReadResponsePayload> {
  if (typeof RTCPeerConnection === 'undefined') throw new Error('WebRTC is unavailable in this browser.');
  const transferId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URL }] });
  const dc = pc.createDataChannel('file', { ordered: true });
  dc.binaryType = 'arraybuffer';
  let unsubscribe = () => {};
  let settled = false;

  const cleanup = () => {
    unsubscribe();
    try { dc.close(); } catch { /* already closed */ }
    try { pc.close(); } catch { /* already closed */ }
  };
  const cancelRemote = () => {
    void bus.command('files:rtc-cancel', { transferId }, {
      timeoutMs: 3_000,
      queueWhileDisconnected: false,
    }).catch(() => {});
  };

  try {
    const result = await new Promise<FilesReadResponsePayload>((resolve, reject) => {
      let header: Extract<FilesRtcDataMessage, { t: 'header' }> | null = null;
      const chunks: Uint8Array[] = [];
      let receivedBytes = 0;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      let transferTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (connectTimer) clearTimeout(connectTimer);
        if (transferTimer) clearTimeout(transferTimer);
        options.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const fail = (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      const onAbort = () => {
        cancelRemote();
        fail(new DOMException('File transfer cancelled.', 'AbortError'));
      };
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener('abort', onAbort, { once: true });

      connectTimer = setTimeout(() => fail(new Error('WebRTC file connection timed out.')), CONNECT_TIMEOUT_MS);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') fail(new Error('Direct file connection failed.'));
      };
      pc.onicecandidate = (event) => {
        const candidate = event.candidate ? JSON.stringify(event.candidate.toJSON()) : null;
        void bus.command<unknown, FilesRtcIceRequestPayload>('files:rtc-ice', {
          transferId,
          candidate,
        }, { timeoutMs: 5_000, queueWhileDisconnected: false }).catch(() => {});
      };

      unsubscribe = bus.subscribe<FilesRtcIceUpdate, FilesRtcIceUpdate>(`/files/rtc/${transferId}`, {
        onSnapshot: (update) => applyRemoteIce(pc, update),
        onUpdate: (update) => applyRemoteIce(pc, update),
      });

      dc.onopen = () => {
        if (connectTimer) clearTimeout(connectTimer);
        transferTimer = setTimeout(() => fail(new Error('WebRTC file transfer timed out.')), TRANSFER_TIMEOUT_MS);
      };
      dc.onerror = () => fail(new Error('WebRTC file DataChannel failed.'));
      dc.onclose = () => {
        if (!settled) fail(new Error('WebRTC file DataChannel closed before completion.'));
      };
      dc.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          if (!header) return fail(new Error('Invalid file transfer frame.'));
          const chunk = event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : ArrayBuffer.isView(event.data)
              ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
              : null;
          if (!chunk) return fail(new Error('Invalid file transfer frame.'));
          chunks.push(chunk);
          receivedBytes += chunk.byteLength;
          if (receivedBytes > header.size) return fail(new Error('File transfer exceeded its declared size.'));
          options.onProgress?.({ receivedBytes, totalBytes: header.size });
          return;
        }
        let message: FilesRtcDataMessage;
        try {
          message = JSON.parse(event.data) as FilesRtcDataMessage;
        } catch {
          return fail(new Error('Invalid file transfer control message.'));
        }
        if (message.t === 'error') return fail(new Error(message.message));
        if (message.t === 'header') {
          header = message;
          options.onProgress?.({ receivedBytes: 0, totalBytes: message.size });
          return;
        }
        if (message.t === 'complete') {
          if (!header) return fail(new Error('File transfer completed without metadata.'));
          void assembleRtcFileResponse(header, chunks, receivedBytes, message)
            .then((response) => finish(() => resolve(response)))
            .catch(fail);
        }
      };

      void (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          const response = await bus.command<FilesRtcConnectResponsePayload, FilesRtcConnectRequestPayload>(
            'files:rtc-connect',
            {
              transferId,
              cwd: request.cwd,
              path: request.path,
              allowImage: request.allowImage,
              sdp: offer.sdp ?? '',
            },
            { timeoutMs: 15_000, queueWhileDisconnected: false },
          );
          if (response.error || !response.sdp) throw new Error(response.error || 'Agent returned no SDP answer.');
          await pc.setRemoteDescription({ type: 'answer', sdp: response.sdp });
        } catch (error) {
          fail(error);
        }
      })();
    });
    return result;
  } finally {
    cleanup();
    cancelRemote();
  }
}

export async function assembleRtcFileResponse(
  header: Extract<FilesRtcDataMessage, { t: 'header' }>,
  chunks: Uint8Array[],
  receivedBytes: number,
  complete: Extract<FilesRtcDataMessage, { t: 'complete' }>,
): Promise<FilesReadResponsePayload> {
  if (receivedBytes !== header.size || complete.bytes !== receivedBytes) {
    throw new Error(`Incomplete file transfer (${receivedBytes}/${header.size} bytes).`);
  }
  const bytes = concatChunks(chunks, receivedBytes);
  if (complete.sha256) {
    const digest = await sha256Hex(bytes);
    if (digest !== complete.sha256) throw new Error('File transfer checksum mismatch.');
  }
  return {
    success: true,
    cwd: header.cwd,
    path: header.path,
    absolutePath: header.absolutePath,
    size: header.size,
    mtime: header.mtime,
    kind: header.kind,
    mimeType: header.mimeType,
    encoding: header.kind === 'text' ? 'utf-8' : 'base64',
    content: header.kind === 'text'
      ? new TextDecoder().decode(bytes)
      : bytesToBase64(bytes),
  };
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 32 * 1024;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Blob copies cross-realm views into an ArrayBuffer owned by the current
  // browser realm, which Web Crypto requires on stricter runtimes.
  const input = await new Blob([new Uint8Array(bytes)]).arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function applyRemoteIce(pc: RTCPeerConnection, update: FilesRtcIceUpdate | undefined): void {
  if (!update?.candidate) return;
  try {
    void pc.addIceCandidate(JSON.parse(update.candidate));
  } catch { /* malformed candidate */ }
}
