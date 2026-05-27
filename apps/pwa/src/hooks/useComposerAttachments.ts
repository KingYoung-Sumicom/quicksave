// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Shared attachment-composer logic (file/image/text/long-paste) for message
 * composers. Owns the pending-chip state + upload manager wiring, file-pick,
 * drag-and-drop, paste ingestion, kind filtering, send-readiness gating, and
 * building the `attachmentIds` / `attachmentMetadata` payload. The caller
 * renders the chips/buttons and supplies how rejections surface (`onReject`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentKind, AttachmentMetadata } from '@sumicom/quicksave-shared';
import {
  startUpload,
  cancelUpload,
  forgetUpload,
  useAttachmentUploadStore,
  type PendingAttachment,
} from '../lib/attachmentUploader';
import {
  attachmentsFromDataTransfer,
  inspectPaste,
  processPasteInspection,
  type PendingAttachmentDraft,
} from '../lib/attachments';

interface Options {
  agentId: string;
  supportsAttachments: boolean;
  supportedAttachmentKinds: AttachmentKind[];
  /** Provider label, for "X does not support Y attachments" messages. */
  agentLabel: string;
  /** Surface rejected-file messages (e.g. as a toast). */
  onReject: (message: string) => void;
}

export interface UseComposerAttachments {
  pendingAttachments: PendingAttachment[];
  allUploadsReady: boolean;
  anyUploadInFlight: boolean;
  isDraggingFile: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  removePendingAttachment: (id: string) => void;
  handleFilePick: (files: FileList | null) => Promise<void>;
  /** Synchronously decides whether to consume a paste; returns true if the
   *  caller should `preventDefault()` (it kicks off async ingestion). */
  tryConsumePaste: (clipboard: DataTransfer | null) => boolean;
  dragHandlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => Promise<void>;
  };
  /** Build the send payload from currently-pending attachments. */
  buildPayload: () => { attachmentIds: string[]; attachmentMetadata: AttachmentMetadata[] };
  /** Drop all pending chips (does not forget uploads — see forgetSent). */
  clear: () => void;
  /** Release upload-manager state for chips that just shipped. */
  forgetSent: (ids: string[]) => void;
}

export function useComposerAttachments(opts: Options): UseComposerAttachments {
  const { agentId, supportsAttachments, supportedAttachmentKinds, agentLabel, onReject } = opts;

  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const pastedTextCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadStates = useAttachmentUploadStore((s) => s.uploads);

  const allUploadsReady = pendingAttachments.every((p) => uploadStates[p.id]?.status === 'ready');
  const anyUploadInFlight = pendingAttachments.some((p) => {
    const s = uploadStates[p.id]?.status;
    return s === 'queued' || s === 'uploading';
  });

  const ingestAttachments = useCallback((drafts: PendingAttachmentDraft[], rejected: { message: string }[]) => {
    if (drafts.length > 0) {
      const withAgent: PendingAttachment[] = drafts.map((d) => ({ ...d, agentId }));
      setPendingAttachments((prev) => [...prev, ...withAgent]);
      for (const a of withAgent) startUpload(a);
    }
    if (rejected.length > 0) onReject(rejected.map((r) => r.message).join('\n'));
  }, [agentId, onReject]);

  const filterUnsupported = useCallback((result: {
    accepted: PendingAttachmentDraft[];
    rejected: { name: string; reason: string; message: string }[];
  }) => {
    if (supportedAttachmentKinds.length === 0) return result;
    const allowed = new Set(supportedAttachmentKinds);
    const accepted: PendingAttachmentDraft[] = [];
    const rejected = [...result.rejected];
    for (const draft of result.accepted) {
      if (allowed.has(draft.kind)) {
        accepted.push(draft);
      } else {
        rejected.push({
          name: draft.name,
          reason: 'unsupported_mime',
          message: `Skipped ${draft.name}: ${agentLabel} does not support ${draft.kind} attachments`,
        });
      }
    }
    return { accepted, rejected };
  }, [agentLabel, supportedAttachmentKinds]);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((p) => p.id !== id));
    void cancelUpload(id);
    forgetUpload(id);
  }, []);

  // When the provider can't take attachments, drop any in-flight chips.
  useEffect(() => {
    if (supportsAttachments || pendingAttachments.length === 0) {
      if (!supportsAttachments) setIsDraggingFile(false);
      return;
    }
    for (const a of pendingAttachments) {
      void cancelUpload(a.id);
      forgetUpload(a.id);
    }
    setPendingAttachments([]);
    setIsDraggingFile(false);
  }, [supportsAttachments, pendingAttachments]);

  const handleFilePick = useCallback(async (files: FileList | null) => {
    if (!supportsAttachments || !files || files.length === 0) return;
    const dt = new DataTransfer();
    for (let i = 0; i < files.length; i++) {
      const f = files.item(i);
      if (f) dt.items.add(f);
    }
    const result = filterUnsupported(await attachmentsFromDataTransfer(dt, pendingAttachments.length));
    ingestAttachments(result.accepted, result.rejected);
  }, [supportsAttachments, pendingAttachments.length, ingestAttachments, filterUnsupported]);

  const tryConsumePaste = useCallback((clipboard: DataTransfer | null): boolean => {
    if (!supportsAttachments) return false;
    const inspection = inspectPaste(clipboard);
    if (inspection.mode === 'passthrough') return false;
    const o = { existingCount: pendingAttachments.length, pastedTextIndex: pastedTextCountRef.current + 1 };
    if (inspection.mode === 'long-text') pastedTextCountRef.current += 1;
    void processPasteInspection(inspection, o).then((result) => {
      const filtered = filterUnsupported(result);
      if (filtered.accepted.length > 0 || filtered.rejected.length > 0) {
        ingestAttachments(filtered.accepted, filtered.rejected);
      }
    });
    return true;
  }, [supportsAttachments, pendingAttachments.length, ingestAttachments, filterUnsupported]);

  const dragHandlers = {
    onDragOver: useCallback((e: React.DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        setIsDraggingFile(true);
      }
    }, []),
    onDragLeave: useCallback((e: React.DragEvent) => {
      if (e.target === e.currentTarget) setIsDraggingFile(false);
    }, []),
    onDrop: useCallback(async (e: React.DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      setIsDraggingFile(false);
      const result = filterUnsupported(await attachmentsFromDataTransfer(e.dataTransfer, pendingAttachments.length));
      ingestAttachments(result.accepted, result.rejected);
    }, [filterUnsupported, ingestAttachments, pendingAttachments.length]),
  };

  const buildPayload = useCallback(() => {
    const attachmentIds = pendingAttachments.map((p) => p.id);
    const attachmentMetadata: AttachmentMetadata[] = pendingAttachments.map((p) => ({
      id: p.id,
      kind: p.kind,
      mimeType: p.mimeType,
      name: p.name,
      size: p.bytes.byteLength,
    }));
    return { attachmentIds, attachmentMetadata };
  }, [pendingAttachments]);

  const clear = useCallback(() => setPendingAttachments([]), []);
  const forgetSent = useCallback((ids: string[]) => { for (const id of ids) forgetUpload(id); }, []);

  return {
    pendingAttachments,
    allUploadsReady,
    anyUploadInFlight,
    isDraggingFile,
    fileInputRef,
    removePendingAttachment,
    handleFilePick,
    tryConsumePaste,
    dragHandlers,
    buildPayload,
    clear,
    forgetSent,
  };
}
