// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
// ============================================================================
// Attachment upload manager.
//
// Streams a `PendingAttachment` (raw bytes) to the agent in fixed-size chunks
// via the `attachment:upload` bus command. Per-attachment progress lives in a
// Zustand store; chips subscribe via `useAttachmentUpload(id)`.
//
// Concurrency model: serial chunks per attachment (chunk N+1 is dispatched
// only after chunk N's response). Multiple attachments upload in parallel
// because each owns its own state machine.
//
// The bus client's `queueWhileDisconnected` buffers commands during a brief
// disconnect, so a simple disconnect/reconnect window resolves transparently.
// On long disconnects where the agent's staging GC drops the record, the
// next chunk command rejects with `attachment_not_found`; the manager
// surfaces that as `error` and the chip can offer a "retry" that calls
// `restartUpload(id)`.
// ============================================================================

import { create } from 'zustand';
import {
  ATTACHMENT_CHUNK_BYTES,
  type Attachment,
  type AttachmentKind,
  type AttachmentUploadRequestPayload,
  type AttachmentUploadResponsePayload,
  type AttachmentCancelRequestPayload,
  type AttachmentCancelResponsePayload,
} from '@sumicom/quicksave-shared';
import { getBusForAgent } from './busRegistry';
import { primeAttachment } from './attachmentCache';

// ── Public types ──────────────────────────────────────────────────────────

/** What the composer hands to the uploader. The bytes are the source of truth;
 *  base64 is computed per-chunk inside the uploader. */
export interface PendingAttachment {
  id: string;
  kind: AttachmentKind;
  mimeType: string;
  name: string;
  bytes: Uint8Array;
  /** Agent that will receive the upload chunks. */
  agentId: string;
}

export type UploadStatus = 'queued' | 'uploading' | 'ready' | 'cancelled' | 'error';

export interface UploadState {
  id: string;
  status: UploadStatus;
  /** 0..1. */
  progress: number;
  /** Bytes acknowledged by the agent so far. */
  receivedBytes: number;
  totalBytes: number;
  error?: string;
}

// ── Zustand store ─────────────────────────────────────────────────────────

interface UploadStore {
  uploads: Record<string, UploadState>;
  setUpload: (id: string, patch: Partial<UploadState> & { id?: string }) => void;
  removeUpload: (id: string) => void;
}

export const useAttachmentUploadStore = create<UploadStore>((set) => ({
  uploads: {},
  setUpload: (id, patch) =>
    set((s) => {
      const base: UploadState = s.uploads[id] ?? {
        id,
        status: 'queued',
        progress: 0,
        receivedBytes: 0,
        totalBytes: 0,
      };
      const merged: UploadState = { ...base, ...patch, id };
      return { uploads: { ...s.uploads, [id]: merged } };
    }),
  removeUpload: (id) =>
    set((s) => {
      if (!(id in s.uploads)) return s;
      const next = { ...s.uploads };
      delete next[id];
      return { uploads: next };
    }),
}));

/** Subscribe a component to one attachment's upload state. */
export function useAttachmentUpload(id: string | null | undefined): UploadState | undefined {
  return useAttachmentUploadStore((s) => (id ? s.uploads[id] : undefined));
}

// ── Internal: per-attachment task tracking ────────────────────────────────

interface UploadTask {
  pending: PendingAttachment;
  totalChunks: number;
  /** Index of the next chunk to send. */
  cursor: number;
  cancelled: boolean;
}

const tasks = new Map<string, UploadTask>();

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Begin uploading `pending`. Idempotent: calling twice for the same id
 * (without an intervening cancel/remove) is a no-op while the first run is
 * still in flight.
 */
export function startUpload(pending: PendingAttachment): void {
  if (tasks.has(pending.id)) {
    console.log(`[uploader] startUpload skipped (already tracked) id=${pending.id}`);
    return;
  }

  const totalBytes = pending.bytes.byteLength;
  const totalChunks = Math.max(1, Math.ceil(totalBytes / ATTACHMENT_CHUNK_BYTES));
  console.log(`[uploader] startUpload id=${pending.id} kind=${pending.kind} mime=${pending.mimeType} bytes=${totalBytes} chunks=${totalChunks}`);
  const task: UploadTask = { pending, totalChunks, cursor: 0, cancelled: false };
  tasks.set(pending.id, task);

  useAttachmentUploadStore.getState().setUpload(pending.id, {
    status: 'queued',
    progress: 0,
    receivedBytes: 0,
    totalBytes,
    error: undefined,
  });

  void runTask(task);
}

/**
 * Cancel an in-flight upload and tell the agent to drop staging. Safe to
 * call for an already-finished or unknown id.
 */
export async function cancelUpload(id: string): Promise<void> {
  const task = tasks.get(id);
  const agentId = task?.pending.agentId;
  if (task) {
    task.cancelled = true;
    tasks.delete(id);
  }
  useAttachmentUploadStore.getState().setUpload(id, { status: 'cancelled' });

  const bus = agentId ? getBusForAgent(agentId) : null;
  if (!bus) return;
  try {
    await bus.command<AttachmentCancelResponsePayload, AttachmentCancelRequestPayload>(
      'attachment:cancel',
      { attachmentId: id },
      { timeoutMs: 10_000, queueWhileDisconnected: false },
    );
  } catch {
    // Best-effort — if the cancel can't reach the agent, staging will GC the
    // entry on its TTL and there's nothing to retry.
  }
}

/**
 * Restart an upload from chunk 0 (e.g. after an `attachment_not_found`
 * error caused by agent-side staging GC). The original bytes are reused
 * from the existing task; if the task was already removed, this is a no-op.
 */
export function restartUpload(id: string): void {
  const task = tasks.get(id);
  if (!task) return;
  task.cursor = 0;
  task.cancelled = false;
  useAttachmentUploadStore.getState().setUpload(id, {
    status: 'queued',
    progress: 0,
    receivedBytes: 0,
    error: undefined,
  });
  void runTask(task);
}

/** Drop an upload's store entry once the chip is gone from the composer. */
export function forgetUpload(id: string): void {
  tasks.delete(id);
  useAttachmentUploadStore.getState().removeUpload(id);
}

/**
 * After `claude:start` returns a sessionId, push the local upload bytes into
 * the attachment cache for that session so the same tab never has to re-fetch
 * what it just uploaded. Other tabs / reloads still go through the wire.
 *
 * Idempotent: re-priming the same id overwrites the cache entry. If the task
 * is no longer tracked (already forgotten), this is a no-op.
 */
export function primeUploadedAttachment(sessionId: string, attachmentId: string): void {
  const task = tasks.get(attachmentId);
  if (!task) return;
  const attachment: Attachment = {
    id: task.pending.id,
    kind: task.pending.kind,
    mimeType: task.pending.mimeType,
    name: task.pending.name,
    size: task.pending.bytes.byteLength,
    data: bytesToBase64(task.pending.bytes),
  };
  primeAttachment(sessionId, attachment);
}

// ── Internal: chunk loop ──────────────────────────────────────────────────

async function runTask(task: UploadTask): Promise<void> {
  const { pending, totalChunks } = task;
  const totalBytes = pending.bytes.byteLength;

  useAttachmentUploadStore.getState().setUpload(pending.id, { status: 'uploading' });

  while (task.cursor < totalChunks) {
    if (task.cancelled) return;

    const chunkIndex = task.cursor;
    const start = chunkIndex * ATTACHMENT_CHUNK_BYTES;
    const end = Math.min(start + ATTACHMENT_CHUNK_BYTES, totalBytes);
    const slice = pending.bytes.subarray(start, end);
    const chunkB64 = bytesToBase64(slice);

    const payload: AttachmentUploadRequestPayload = {
      attachmentId: pending.id,
      chunkIndex,
      chunk: chunkB64,
      ...(chunkIndex === 0
        ? {
            meta: {
              kind: pending.kind,
              mimeType: pending.mimeType,
              name: pending.name,
              size: totalBytes,
              totalChunks,
            },
          }
        : {}),
    };

    const bus = getBusForAgent(pending.agentId);
    if (!bus) {
      console.warn(`[uploader] no bus for agent ${pending.agentId}, marking error id=${pending.id}`);
      useAttachmentUploadStore.getState().setUpload(pending.id, {
        status: 'error',
        error: 'Not connected',
      });
      return;
    }

    try {
      console.log(`[uploader] sending chunk id=${pending.id} idx=${chunkIndex}/${totalChunks - 1} bytes=${slice.byteLength}`);
      const res = await bus.command<AttachmentUploadResponsePayload, AttachmentUploadRequestPayload>(
        'attachment:upload',
        payload,
        // Per-chunk uploads queue across short disconnects so a brief blip
        // resolves transparently. A long disconnect that GCs the staging
        // record returns `attachment_not_found` on the resumed chunk and we
        // surface it as an error.
        { timeoutMs: 60_000, queueWhileDisconnected: true },
      );
      console.log(`[uploader] ack chunk id=${pending.id} idx=${chunkIndex} received=${res.receivedBytes} ready=${res.ready}`);

      if (task.cancelled) return;

      task.cursor += 1;

      const progress = totalBytes === 0 ? 1 : res.receivedBytes / totalBytes;
      useAttachmentUploadStore.getState().setUpload(pending.id, {
        status: res.ready ? 'ready' : 'uploading',
        progress,
        receivedBytes: res.receivedBytes,
      });

      if (res.ready) {
        // Done — keep the task entry for restartUpload() until the composer
        // calls forgetUpload(id) when the chip is sent or removed.
        return;
      }
    } catch (error) {
      if (task.cancelled) return;
      const message = errorMessageOf(error);
      console.error(`[uploader] chunk failed id=${pending.id} idx=${chunkIndex}:`, error);
      useAttachmentUploadStore.getState().setUpload(pending.id, {
        status: 'error',
        error: message,
      });
      return;
    }
  }
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Upload failed';
}

// ── Base64 encoding (browser, no Buffer) ──────────────────────────────────

/**
 * Encode a Uint8Array slice to base64 without using `Buffer`. Chunks the
 * `String.fromCharCode(...)` call to avoid blowing the JS argument limit on
 * large slices (~512 KB is fine, but be safe).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000; // 32 KB at a time
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
    binary += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(binary);
}
