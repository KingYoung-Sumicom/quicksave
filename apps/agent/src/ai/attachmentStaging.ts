// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
// ============================================================================
// Attachment staging — buffers chunked uploads from a peer until they are
// consumed by a `claude:start` / `claude:resume` whose payload references
// the attachment ids. Buffers live in memory; the GC loop drops idle records
// after `ATTACHMENT_STAGING_TTL_MS`.
// ============================================================================

import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_STAGING_TTL_MS,
  PDF_MAX_PAGES,
  PER_PEER_STAGING_MAX_BYTES,
  type Attachment,
  type AttachmentKind,
  type AttachmentUploadRequestPayload,
  type AttachmentUploadResponsePayload,
} from '@sumicom/quicksave-shared';
import { countPdfPages } from './pdfMeta.js';

interface StagedAttachment {
  attachmentId: string;
  kind: AttachmentKind;
  mimeType: string;
  name: string;
  /** Raw decoded byte size declared by the uploader. */
  size: number;
  totalChunks: number;
  /** Decoded chunk buffers, indexed by chunkIndex. Sparse until all arrive. */
  chunks: (Buffer | undefined)[];
  /** Sum of `chunks[i].length` for chunks already received. */
  receivedBytes: number;
  /** Count of distinct chunk indexes received (allows ready-check without scan). */
  receivedCount: number;
  /** Wall-clock ms — bumped on every accept; staleness is `now - lastTouchedAt`. */
  lastTouchedAt: number;
}

export interface AttachmentNotFoundError extends Error {
  code: 'attachment_not_found';
  attachmentId: string;
}
export interface AttachmentNotReadyError extends Error {
  code: 'attachment_not_ready';
  attachmentId: string;
}
export interface AttachmentTooLargeError extends Error {
  code: 'attachment_too_large';
  attachmentId: string;
}
export interface AttachmentTooManyPagesError extends Error {
  code: 'attachment_too_many_pages';
  attachmentId: string;
}
export interface AttachmentBadRequestError extends Error {
  code: 'attachment_bad_request';
  attachmentId: string;
}
export interface AttachmentPeerQuotaError extends Error {
  code: 'attachment_peer_quota';
}

type StagingError =
  | AttachmentNotFoundError
  | AttachmentNotReadyError
  | AttachmentTooLargeError
  | AttachmentTooManyPagesError
  | AttachmentBadRequestError
  | AttachmentPeerQuotaError;

function makeError<C extends StagingError['code']>(
  code: C,
  message: string,
  extra: Partial<StagingError> = {},
): Error & { code: C } {
  const err = new Error(message) as Error & { code: C };
  (err as unknown as { code: C }).code = code;
  Object.assign(err, extra);
  return err;
}

export interface AttachmentStagingOptions {
  /** Override TTL — primarily for tests. */
  ttlMs?: number;
  /** Override per-peer cap — primarily for tests. */
  perPeerMaxBytes?: number;
  /** Custom clock — primarily for tests. */
  now?: () => number;
}

/**
 * In-memory staging map keyed by `(peerAddress, attachmentId)`. One instance
 * per agent process; the messageHandler injects the peer address on every
 * request.
 */
export class AttachmentStaging {
  private readonly byPeer = new Map<string, Map<string, StagedAttachment>>();
  private readonly perPeerBytes = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly perPeerMaxBytes: number;
  private readonly now: () => number;

  constructor(opts: AttachmentStagingOptions = {}) {
    this.ttlMs = opts.ttlMs ?? ATTACHMENT_STAGING_TTL_MS;
    this.perPeerMaxBytes = opts.perPeerMaxBytes ?? PER_PEER_STAGING_MAX_BYTES;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Apply one upload chunk. Returns the running progress + ready flag.
   * Throws a tagged Error (`code` field) for validation failures so the
   * messageHandler can map them to bus error responses.
   */
  acceptChunk(peerAddress: string, payload: AttachmentUploadRequestPayload): AttachmentUploadResponsePayload {
    const { attachmentId, chunkIndex, chunk, meta } = payload;
    if (!attachmentId || typeof attachmentId !== 'string') {
      throw makeError('attachment_bad_request', 'attachmentId required', { attachmentId: String(attachmentId) });
    }
    if (typeof chunkIndex !== 'number' || chunkIndex < 0 || !Number.isInteger(chunkIndex)) {
      throw makeError('attachment_bad_request', 'chunkIndex must be a non-negative integer', { attachmentId });
    }
    if (typeof chunk !== 'string') {
      throw makeError('attachment_bad_request', 'chunk must be base64 string', { attachmentId });
    }

    const peerMap = this.byPeer.get(peerAddress) ?? new Map<string, StagedAttachment>();
    let staged = peerMap.get(attachmentId);

    if (!staged) {
      // First time we see this id — meta is required.
      if (!meta) {
        throw makeError('attachment_bad_request', 'meta required on first chunk', { attachmentId });
      }
      this.validateMeta(attachmentId, meta);
      staged = {
        attachmentId,
        kind: meta.kind,
        mimeType: meta.mimeType,
        name: meta.name,
        size: meta.size,
        totalChunks: meta.totalChunks,
        chunks: new Array<Buffer | undefined>(meta.totalChunks),
        receivedBytes: 0,
        receivedCount: 0,
        lastTouchedAt: this.now(),
      };
      peerMap.set(attachmentId, staged);
      this.byPeer.set(peerAddress, peerMap);
    } else if (meta) {
      // Subsequent chunks may include meta but must be consistent.
      if (
        meta.kind !== staged.kind
        || meta.mimeType !== staged.mimeType
        || meta.name !== staged.name
        || meta.size !== staged.size
        || meta.totalChunks !== staged.totalChunks
      ) {
        throw makeError('attachment_bad_request', 'meta mismatch for existing attachment', { attachmentId });
      }
    }

    if (chunkIndex >= staged.totalChunks) {
      throw makeError('attachment_bad_request', `chunkIndex ${chunkIndex} >= totalChunks ${staged.totalChunks}`, { attachmentId });
    }
    if (staged.chunks[chunkIndex] !== undefined) {
      // Idempotent re-send: if the bytes match, no-op; otherwise reject.
      const existing = staged.chunks[chunkIndex]!;
      const incoming = Buffer.from(chunk, 'base64');
      if (existing.equals(incoming)) {
        staged.lastTouchedAt = this.now();
        return { attachmentId, receivedBytes: staged.receivedBytes, ready: this.isReady(staged) };
      }
      throw makeError('attachment_bad_request', `chunk ${chunkIndex} already received with different bytes`, { attachmentId });
    }

    const buf = Buffer.from(chunk, 'base64');
    const nextRunningBytes = staged.receivedBytes + buf.length;
    if (nextRunningBytes > staged.size) {
      throw makeError('attachment_too_large', `running bytes exceeds declared size`, { attachmentId });
    }

    const peerTotal = this.perPeerBytes.get(peerAddress) ?? 0;
    if (peerTotal + buf.length > this.perPeerMaxBytes) {
      throw makeError('attachment_peer_quota', 'per-peer staging quota exceeded');
    }

    staged.chunks[chunkIndex] = buf;
    staged.receivedBytes = nextRunningBytes;
    staged.receivedCount += 1;
    staged.lastTouchedAt = this.now();
    this.perPeerBytes.set(peerAddress, peerTotal + buf.length);

    const ready = this.isReady(staged);
    if (ready && staged.receivedBytes !== staged.size) {
      // Strict: declared size must match received bytes when ready.
      this.dropEntry(peerAddress, attachmentId);
      throw makeError('attachment_bad_request', 'received bytes do not match declared size', { attachmentId });
    }

    // Page-count check on PDF completion. The Anthropic API rejects PDFs over
    // PDF_MAX_PAGES and the SDK rewrites the rejection as a poison "PDF too
    // large" assistant block — drop the entry now so the user sees a clean
    // error instead of a stuck session. countPdfPages returns null/0 for
    // PDFs where pages live in compressed object streams (rare); in that
    // case we let it through and fall back to the recovery card path.
    if (ready && staged.kind === 'pdf') {
      const pages = countPdfPages(Buffer.concat(staged.chunks as Buffer[]));
      if (pages !== null && pages > PDF_MAX_PAGES) {
        this.dropEntry(peerAddress, attachmentId);
        throw makeError(
          'attachment_too_many_pages',
          `PDF has ${pages} pages (max ${PDF_MAX_PAGES})`,
          { attachmentId },
        );
      }
    }

    return { attachmentId, receivedBytes: staged.receivedBytes, ready };
  }

  /**
   * Atomically remove and return the requested attachments. Throws on the
   * first missing or not-ready id (with that id in the error). On error,
   * **no** attachments are consumed — callers can retry safely.
   */
  consume(peerAddress: string, attachmentIds: readonly string[]): Attachment[] {
    if (attachmentIds.length === 0) return [];
    const peerMap = this.byPeer.get(peerAddress);
    if (!peerMap) {
      throw makeError('attachment_not_found', `no staged attachments for peer`, { attachmentId: attachmentIds[0] });
    }
    // Validate all first, then remove.
    for (const id of attachmentIds) {
      const s = peerMap.get(id);
      if (!s) throw makeError('attachment_not_found', `attachment ${id} not staged`, { attachmentId: id });
      if (!this.isReady(s)) throw makeError('attachment_not_ready', `attachment ${id} not ready`, { attachmentId: id });
    }
    const result: Attachment[] = [];
    for (const id of attachmentIds) {
      const s = peerMap.get(id)!;
      const data = Buffer.concat(s.chunks as Buffer[]).toString('base64');
      result.push({
        id: s.attachmentId,
        kind: s.kind,
        mimeType: s.mimeType,
        name: s.name,
        size: s.size,
        data,
      });
      this.dropEntry(peerAddress, id);
    }
    return result;
  }

  /** Drop a staged attachment if present. Returns true if anything was removed. */
  cancel(peerAddress: string, attachmentId: string): boolean {
    return this.dropEntry(peerAddress, attachmentId);
  }

  /** Drop every staging record for a peer (called on disconnect). */
  removePeer(peerAddress: string): void {
    this.byPeer.delete(peerAddress);
    this.perPeerBytes.delete(peerAddress);
  }

  /** Sweep expired entries. Safe to call from a periodic timer. */
  gc(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [peer, map] of this.byPeer) {
      for (const [id, s] of map) {
        if (s.lastTouchedAt <= cutoff) {
          this.dropEntry(peer, id);
        }
      }
      if (map.size === 0) {
        this.byPeer.delete(peer);
        this.perPeerBytes.delete(peer);
      }
    }
  }

  /** Test/diagnostic: count of staged records for a peer. */
  size(peerAddress: string): number {
    return this.byPeer.get(peerAddress)?.size ?? 0;
  }

  /** Test/diagnostic: bytes currently held for a peer. */
  bytesFor(peerAddress: string): number {
    return this.perPeerBytes.get(peerAddress) ?? 0;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private validateMeta(attachmentId: string, meta: NonNullable<AttachmentUploadRequestPayload['meta']>): void {
    if (!meta.kind || !ATTACHMENT_LIMITS[meta.kind]) {
      throw makeError('attachment_bad_request', `unknown kind`, { attachmentId });
    }
    if (typeof meta.size !== 'number' || meta.size <= 0 || !Number.isFinite(meta.size)) {
      throw makeError('attachment_bad_request', 'invalid size', { attachmentId });
    }
    if (meta.size > ATTACHMENT_LIMITS[meta.kind].maxBytes) {
      throw makeError('attachment_too_large', `${meta.kind} exceeds ${ATTACHMENT_LIMITS[meta.kind].maxBytes} bytes`, { attachmentId });
    }
    if (typeof meta.totalChunks !== 'number' || meta.totalChunks <= 0 || !Number.isInteger(meta.totalChunks)) {
      throw makeError('attachment_bad_request', 'invalid totalChunks', { attachmentId });
    }
    if (typeof meta.mimeType !== 'string' || meta.mimeType.length === 0) {
      throw makeError('attachment_bad_request', 'invalid mimeType', { attachmentId });
    }
    if (typeof meta.name !== 'string' || meta.name.length === 0) {
      throw makeError('attachment_bad_request', 'invalid name', { attachmentId });
    }
  }

  private isReady(s: StagedAttachment): boolean {
    return s.receivedCount === s.totalChunks;
  }

  private dropEntry(peerAddress: string, attachmentId: string): boolean {
    const peerMap = this.byPeer.get(peerAddress);
    if (!peerMap) return false;
    const s = peerMap.get(attachmentId);
    if (!s) return false;
    peerMap.delete(attachmentId);
    const remainingBytes = (this.perPeerBytes.get(peerAddress) ?? 0) - s.receivedBytes;
    if (remainingBytes > 0) {
      this.perPeerBytes.set(peerAddress, remainingBytes);
    } else {
      this.perPeerBytes.delete(peerAddress);
    }
    if (peerMap.size === 0) {
      this.byPeer.delete(peerAddress);
    }
    return true;
  }
}
