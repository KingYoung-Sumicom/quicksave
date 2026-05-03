// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
// ============================================================================
// Attachment types — files and long-pasted text the user attaches to a chat
// message. The PWA streams the bytes up via `attachment:upload` (chunked)
// before the user hits send; the agent stages them in memory keyed by peer
// and resolves them by id when `claude:start` / `claude:resume` arrives.
// ============================================================================

export type AttachmentKind = 'image' | 'pdf' | 'text';

/**
 * Lightweight attachment descriptor — id + display info, no bytes. This is
 * what flows on:
 *  - `UserCard.attachments[]` (card history snapshots),
 *  - any list / summary surface the PWA paints before the user clicks.
 *
 * Bytes are fetched on demand via `attachment:fetch { sessionId,
 * attachmentId }` and cached in the PWA. This keeps card snapshots cheap.
 */
export interface AttachmentMetadata {
  id: string;
  kind: AttachmentKind;
  /** IANA media type, e.g. 'image/png', 'application/pdf', 'text/markdown'. */
  mimeType: string;
  /** Display filename (no path). For long-paste collapse: 'pasted-1.txt' etc. */
  name: string;
  /** Raw byte size of the decoded payload (informational; for chip rendering). */
  size: number;
}

/**
 * Full attachment record — metadata plus the base64 payload. Lives in:
 *  - PWA composer state (between pick and send),
 *  - Agent staging map (between upload and consume),
 *  - `attachment:fetch` responses (one round trip per id, then PWA-cached).
 *
 * `data` is base64 of the decoded payload (no `data:` prefix). For
 * `kind: 'text'`, `data` is base64(utf8 bytes) so the wire shape is
 * uniform across kinds.
 */
export interface Attachment extends AttachmentMetadata {
  data: string;
}

/** What `claude:start` / `claude:resume` payloads carry — id only. */
export interface AttachmentRef {
  id: string;
}

// ── Wire types: chunked upload ─────────────────────────────────────────────

/**
 * One chunk of an attachment upload. The first chunk (chunkIndex 0) MUST
 * include `meta`; subsequent chunks omit it. Chunks may arrive out of order
 * but are validated against the running total declared in `meta.totalChunks`
 * and `meta.size`.
 */
export interface AttachmentUploadRequestPayload {
  attachmentId: string;
  meta?: {
    kind: AttachmentKind;
    mimeType: string;
    name: string;
    /** Raw byte size of the fully-decoded attachment. */
    size: number;
    /** Total number of chunks the sender intends to push. */
    totalChunks: number;
  };
  /** 0-indexed chunk number. */
  chunkIndex: number;
  /** Base64 of this chunk's bytes. */
  chunk: string;
}

export interface AttachmentUploadResponsePayload {
  attachmentId: string;
  /** Bytes received and decoded so far. */
  receivedBytes: number;
  /** True once every declared chunk has arrived and the staged record is complete. */
  ready: boolean;
}

export interface AttachmentCancelRequestPayload {
  attachmentId: string;
}

export interface AttachmentCancelResponsePayload {
  /** True if the staged record was found and dropped, false if it was already gone. */
  removed: boolean;
}

// ── On-demand fetch (PWA → Agent) ─────────────────────────────────────────

export interface AttachmentFetchRequestPayload {
  /** Session that owns this attachment. */
  sessionId: string;
  /** Stable attachment id from `UserCard.attachments[].id`. */
  attachmentId: string;
}

export interface AttachmentFetchResponsePayload {
  /** Full attachment record (metadata + base64 data). */
  attachment: Attachment;
}

// ── Limits ────────────────────────────────────────────────────────────────

export const ATTACHMENT_LIMITS: Record<
  AttachmentKind,
  { maxBytes: number; mimes: readonly string[] }
> = {
  image: {
    maxBytes: 5 * 1024 * 1024,
    mimes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  },
  pdf: {
    // Anthropic API rejects PDFs over 20 MB or 100 pages and the Claude
    // Agent SDK rewrites that as a poison "PDF too large" assistant block
    // (see claudeSdkProvider.ts POISON_PATTERNS) — keep our cap aligned.
    maxBytes: 20 * 1024 * 1024,
    mimes: ['application/pdf'],
  },
  text: {
    maxBytes: 256 * 1024,
    mimes: ['text/*', 'application/json', 'application/xml'],
  },
};

/** Maximum pages in a single PDF attachment. The Anthropic API rejects PDFs
 *  with more pages than this and the SDK rewrites the rejection as a poison
 *  assistant block, so the agent counts pages on upload completion and
 *  rejects oversize PDFs before they reach Claude. */
export const PDF_MAX_PAGES = 100;

/** Raw byte size of one upload chunk (before base64). ~700 KB after base64. */
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;

/** Per-message cap (count). */
export const PER_MESSAGE_MAX_COUNT = 5;

/** Idle staging entries are GC'd after this many ms. */
export const ATTACHMENT_STAGING_TTL_MS = 10 * 60 * 1000;

/** Per-peer staging budget; further chunks are rejected once exceeded. */
export const PER_PEER_STAGING_MAX_BYTES = 128 * 1024 * 1024;

/** A plain-text paste larger than this auto-collapses into a `kind: 'text'` chip. */
export const LONG_PASTE_THRESHOLD_CHARS = 1500;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * True if `mimeType` matches one of the patterns for `kind`. Patterns ending
 * in `/*` (e.g. `text/*`) match the leading type segment.
 */
export function isAttachmentMimeAllowed(kind: AttachmentKind, mimeType: string): boolean {
  const mt = mimeType.toLowerCase();
  for (const pattern of ATTACHMENT_LIMITS[kind].mimes) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
      if (mt.startsWith(prefix)) return true;
    } else if (pattern === mt) {
      return true;
    }
  }
  return false;
}

/** Pick the attachment kind for a mime type, or null if unsupported. */
export function attachmentKindForMime(mimeType: string): AttachmentKind | null {
  const mt = mimeType.toLowerCase();
  if (isAttachmentMimeAllowed('image', mt)) return 'image';
  if (isAttachmentMimeAllowed('pdf', mt)) return 'pdf';
  if (isAttachmentMimeAllowed('text', mt)) return 'text';
  return null;
}
