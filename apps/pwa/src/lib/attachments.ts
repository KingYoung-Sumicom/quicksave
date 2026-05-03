// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
// ============================================================================
// PWA-side helpers for turning user input (file picker / drag-drop / paste /
// long-paste) into `PendingAttachment` records that the upload manager
// streams to the agent.
//
// All inputs go through one of three intake paths:
//   - `fileToAttachment(File)` — direct file picker / drag-drop entry.
//   - `attachmentsFromDataTransfer(DataTransfer)` — drop / clipboard with
//     `kind === 'file'` items.
//   - `pasteToAttachments(ClipboardEvent, opts)` — handles BOTH file items
//     and the long-paste auto-collapse case (pure text > threshold becomes
//     a `kind: 'text'` attachment named `pasted-N.txt`).
// ============================================================================

import {
  ATTACHMENT_LIMITS,
  LONG_PASTE_THRESHOLD_CHARS,
  PER_MESSAGE_MAX_COUNT,
  attachmentKindForMime,
  type AttachmentKind,
} from '@sumicom/quicksave-shared';
import type { PendingAttachment } from './attachmentUploader';

export class AttachmentRejectedError extends Error {
  constructor(
    message: string,
    public readonly reason: 'unsupported_mime' | 'too_large' | 'too_many' | 'empty',
  ) {
    super(message);
    this.name = 'AttachmentRejectedError';
  }
}

export interface AttachmentIntakeResult {
  accepted: PendingAttachment[];
  rejected: { name: string; reason: AttachmentRejectedError['reason']; message: string }[];
}

function newAttachmentId(): string {
  // crypto.randomUUID is available in all modern browsers + the relay env.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build a `PendingAttachment` from a `File`. Validates mime + size; throws
 * `AttachmentRejectedError` on rejection so callers can surface the reason
 * to the user. Reads bytes via `arrayBuffer()` (one-shot).
 */
export async function fileToAttachment(file: File): Promise<PendingAttachment> {
  if (file.size === 0) {
    throw new AttachmentRejectedError(`${file.name} is empty`, 'empty');
  }
  const kind = attachmentKindForMime(file.type);
  if (!kind) {
    throw new AttachmentRejectedError(
      `${file.name}: unsupported file type (${file.type || 'unknown'})`,
      'unsupported_mime',
    );
  }
  const limit = ATTACHMENT_LIMITS[kind].maxBytes;
  if (file.size > limit) {
    throw new AttachmentRejectedError(
      `${file.name} is too large (${formatBytes(file.size)} > ${formatBytes(limit)})`,
      'too_large',
    );
  }
  const buf = await file.arrayBuffer();
  return {
    id: newAttachmentId(),
    kind,
    mimeType: file.type,
    name: file.name,
    bytes: new Uint8Array(buf),
  };
}

/**
 * Convert a `DataTransfer` (drag-drop or paste) into pending attachments.
 * Filters by mime/size, applies the per-message count cap (relative to
 * `existingCount`), and returns both accepted and rejected lists.
 */
export async function attachmentsFromDataTransfer(
  dt: DataTransfer | null,
  existingCount: number,
): Promise<AttachmentIntakeResult> {
  const accepted: PendingAttachment[] = [];
  const rejected: AttachmentIntakeResult['rejected'] = [];
  if (!dt) return { accepted, rejected };

  const files: File[] = [];
  if (dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i++) {
      const f = dt.files.item(i);
      if (f) files.push(f);
    }
  } else if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }

  for (const file of files) {
    if (existingCount + accepted.length >= PER_MESSAGE_MAX_COUNT) {
      rejected.push({
        name: file.name,
        reason: 'too_many',
        message: `Skipped ${file.name}: max ${PER_MESSAGE_MAX_COUNT} attachments per message`,
      });
      continue;
    }
    try {
      accepted.push(await fileToAttachment(file));
    } catch (error) {
      if (error instanceof AttachmentRejectedError) {
        rejected.push({ name: file.name, reason: error.reason, message: error.message });
      } else {
        rejected.push({
          name: file.name,
          reason: 'unsupported_mime',
          message: `${file.name}: ${error instanceof Error ? error.message : 'failed to read'}`,
        });
      }
    }
  }
  return { accepted, rejected };
}

export interface PasteIntakeOptions {
  /** Number of attachments already in the tray — limits intake. */
  existingCount: number;
  /** Index for naming long-paste chips (`pasted-1.txt`, `pasted-2.txt`, …). */
  pastedTextIndex: number;
}

export type PasteInspection =
  | { mode: 'passthrough' }
  | { mode: 'files'; files: File[] }
  | { mode: 'long-text'; text: string }
  | { mode: 'long-text-too-large'; size: number };

/**
 * Synchronously inspect a paste event's clipboard so the caller can decide
 * whether to `event.preventDefault()` *before* yielding to the event loop.
 * iOS Safari finalizes paste insertion the moment the handler returns, so
 * any preventDefault behind an `await` is too late.
 *
 * Snapshots `File` references off `clipboardData.items` while they're
 * still valid; the async processor below operates on those snapshots.
 */
export function inspectPaste(clipboard: DataTransfer | null): PasteInspection {
  if (!clipboard) return { mode: 'passthrough' };

  // 1. File items always win.
  const files: File[] = [];
  if (clipboard.files && clipboard.files.length > 0) {
    for (let i = 0; i < clipboard.files.length; i++) {
      const f = clipboard.files.item(i);
      if (f) files.push(f);
    }
  }
  if (files.length === 0 && clipboard.items && clipboard.items.length > 0) {
    for (let i = 0; i < clipboard.items.length; i++) {
      if (clipboard.items[i].kind === 'file') {
        const f = clipboard.items[i].getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (files.length > 0) return { mode: 'files', files };

  // 2. Long-text auto-collapse.
  const text = clipboard.getData('text/plain');
  if (text.length > LONG_PASTE_THRESHOLD_CHARS) {
    const size = new TextEncoder().encode(text).byteLength;
    if (size > ATTACHMENT_LIMITS.text.maxBytes) {
      return { mode: 'long-text-too-large', size };
    }
    return { mode: 'long-text', text };
  }

  // 3. Short text — let textarea handle it normally.
  return { mode: 'passthrough' };
}

/** Async second half of paste handling: turn a (sync-snapshotted) inspection
 *  into accepted/rejected pending attachments. Pure data — does not touch
 *  the DOM event. */
export async function processPasteInspection(
  inspection: PasteInspection,
  opts: PasteIntakeOptions,
): Promise<AttachmentIntakeResult> {
  if (inspection.mode === 'passthrough') {
    return { accepted: [], rejected: [] };
  }
  if (inspection.mode === 'files') {
    const accepted: PendingAttachment[] = [];
    const rejected: AttachmentIntakeResult['rejected'] = [];
    for (const file of inspection.files) {
      if (opts.existingCount + accepted.length >= PER_MESSAGE_MAX_COUNT) {
        rejected.push({
          name: file.name,
          reason: 'too_many',
          message: `Skipped ${file.name}: max ${PER_MESSAGE_MAX_COUNT} attachments per message`,
        });
        continue;
      }
      try {
        accepted.push(await fileToAttachment(file));
      } catch (error) {
        if (error instanceof AttachmentRejectedError) {
          rejected.push({ name: file.name, reason: error.reason, message: error.message });
        } else {
          rejected.push({
            name: file.name,
            reason: 'unsupported_mime',
            message: `${file.name}: ${error instanceof Error ? error.message : 'failed to read'}`,
          });
        }
      }
    }
    return { accepted, rejected };
  }
  if (inspection.mode === 'long-text-too-large') {
    return {
      accepted: [],
      rejected: [{
        name: `pasted-${opts.pastedTextIndex}.txt`,
        reason: 'too_large',
        message: `Pasted text is too large (${formatBytes(inspection.size)} > ${formatBytes(ATTACHMENT_LIMITS.text.maxBytes)})`,
      }],
    };
  }
  // long-text
  if (opts.existingCount >= PER_MESSAGE_MAX_COUNT) {
    return {
      accepted: [],
      rejected: [{
        name: `pasted-${opts.pastedTextIndex}.txt`,
        reason: 'too_many',
        message: `Skipped pasted text: max ${PER_MESSAGE_MAX_COUNT} attachments per message`,
      }],
    };
  }
  const bytes = new TextEncoder().encode(inspection.text);
  return {
    accepted: [{
      id: newAttachmentId(),
      kind: 'text' satisfies AttachmentKind,
      mimeType: 'text/plain',
      name: `pasted-${opts.pastedTextIndex}.txt`,
      bytes,
    }],
    rejected: [],
  };
}

/** Format byte count as a human-readable string (e.g. `1.4 MB`). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
