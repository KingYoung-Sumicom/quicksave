// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from 'react';
import type { Attachment, AttachmentMetadata } from '@sumicom/quicksave-shared';
import type { PendingAttachment } from '../lib/attachmentUploader';
import { useAttachmentUpload } from '../lib/attachmentUploader';
import { useAttachmentBytes } from '../hooks/useAttachmentBytes';
import { formatBytes } from '../lib/attachments';

/** Decode a base64 string into a Uint8Array. */
function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Trigger a browser download for an in-memory attachment. Uses a Blob URL
 *  (data: URLs do not honor `download` in standalone PWAs and have a 2 MB
 *  ceiling in some browsers). */
function downloadViaAnchor(att: Attachment): void {
  const blob = new Blob([base64ToBytes(att.data) as BlobPart], { type: att.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = att.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** iOS PWA standalone mode ignores `<a download>` and `target="_blank"` only
 *  opens an in-PWA webview. The reliable export path on iOS is the Web Share
 *  API with a `File`, which raises the system share sheet ("Save to Files",
 *  "Save Image", "Mail", …). Falls back to Blob+anchor on browsers without
 *  share-with-files support (most desktops). */
async function shareOrDownload(att: Attachment): Promise<void> {
  try {
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    if (typeof nav.share === 'function' && typeof nav.canShare === 'function') {
      const file = new File([base64ToBytes(att.data) as BlobPart], att.name, { type: att.mimeType });
      const data: ShareData & { files: File[] } = { files: [file], title: att.name };
      if (nav.canShare(data)) {
        await nav.share(data);
        return;
      }
    }
  } catch (err) {
    // AbortError (user dismissed) is fine — don't fall back. Anything else,
    // try the anchor download as a last resort.
    if (err instanceof Error && err.name === 'AbortError') return;
  }
  downloadViaAnchor(att);
}

// ============================================================================
// Preview modal — opens inside the PWA so the WebSocket connection stays put.
// `target="_blank"` on a Blob URL inside a standalone PWA detaches into an
// in-PWA webview that can pause the SW + drop sockets; an iframe avoids that.
// ============================================================================

function AttachmentPreview({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    const blob = new Blob([base64ToBytes(attachment.data) as BlobPart], { type: attachment.mimeType });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onShare = useCallback(() => { void shareOrDownload(attachment); }, [attachment]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/95 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-700 bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-100" title={attachment.name}>
            {attachment.name}
          </div>
          <div className="text-[10px] text-slate-400">{formatBytes(attachment.size)}</div>
        </div>
        <button
          type="button"
          onClick={onShare}
          className="shrink-0 px-2.5 py-1 rounded-md bg-blue-600/80 hover:bg-blue-600 text-xs font-medium text-white"
        >
          Share / Download
        </button>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 w-7 h-7 rounded-full text-slate-300 hover:bg-slate-700 flex items-center justify-center text-lg"
          aria-label="Close preview"
        >
          ×
        </button>
      </div>
      <div className="flex-1 overflow-auto bg-slate-950" onClick={(e) => e.stopPropagation()}>
        {blobUrl && (
          attachment.kind === 'image' ? (
            <div className="w-full h-full flex items-center justify-center p-2">
              <img src={blobUrl} alt={attachment.name} className="max-w-full max-h-full object-contain" />
            </div>
          ) : (
            <iframe
              src={blobUrl}
              title={attachment.name}
              className="w-full h-full border-0 bg-white"
            />
          )
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Composer chip — drives off the upload manager state. Shows progress bar
// while bytes are streaming up; offers a remove ✕ button.
// ============================================================================

export function ComposerChip({
  pending,
  onRemove,
}: {
  pending: PendingAttachment;
  onRemove?: () => void;
}) {
  const upload = useAttachmentUpload(pending.id);
  const thumbnailUrl = useObjectUrl(pending);
  const status = upload?.status ?? 'queued';
  const progress = upload?.progress ?? 0;

  const isImage = pending.kind === 'image';
  const isError = status === 'error';
  const isDone = status === 'ready';

  return (
    <div
      className={`relative flex items-center gap-2 rounded-md border bg-slate-700/60 px-2 py-1 text-xs transition-colors ${
        isError
          ? 'border-red-500/50'
          : isDone
            ? 'border-slate-500/40'
            : 'border-blue-500/40'
      }`}
    >
      <div className="relative shrink-0 w-9 h-9 rounded overflow-hidden bg-slate-800 flex items-center justify-center">
        {isImage && thumbnailUrl ? (
          <img src={thumbnailUrl} alt={pending.name} className="w-full h-full object-cover" />
        ) : (
          <KindIcon kind={pending.kind} />
        )}
        {!isDone && !isError && (
          <div
            className="absolute bottom-0 left-0 h-0.5 bg-blue-400 transition-all"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        )}
      </div>
      <div className="min-w-0 max-w-[14ch]">
        <div className="truncate font-medium text-slate-100" title={pending.name}>
          {pending.name}
        </div>
        <div className={`text-[10px] ${isError ? 'text-red-400' : 'text-slate-400'}`}>
          {isError ? upload?.error ?? 'Upload failed' : statusLabel(status, pending.bytes.byteLength, progress)}
        </div>
      </div>
      {onRemove && (
        <button
          type="button"
          onPointerDown={(e) => { e.preventDefault(); onRemove(); }}
          className="ml-1 shrink-0 w-5 h-5 rounded-full text-slate-400 hover:text-slate-200 hover:bg-slate-600/60 flex items-center justify-center"
          aria-label={`Remove ${pending.name}`}
        >
          ×
        </button>
      )}
    </div>
  );
}

function statusLabel(status: string, totalBytes: number, progress: number): string {
  if (status === 'queued') return 'Queued…';
  if (status === 'uploading') return `${Math.round(progress * 100)}% · ${formatBytes(totalBytes)}`;
  if (status === 'ready') return formatBytes(totalBytes);
  if (status === 'cancelled') return 'Cancelled';
  return formatBytes(totalBytes);
}

function useObjectUrl(pending: PendingAttachment): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (pending.kind !== 'image') return;
    const blob = new Blob([pending.bytes as BlobPart], { type: pending.mimeType });
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [pending.id, pending.kind, pending.mimeType]); // eslint-disable-line react-hooks/exhaustive-deps
  return url;
}

// ============================================================================
// History chip — drives off the on-demand attachment cache. Shows a static
// thumbnail (image) or kind icon. Click to open an in-PWA preview modal
// with a Share/Download action that uses the Web Share API on iOS and
// falls back to a Blob+anchor download elsewhere.
// ============================================================================

export function HistoryChip({
  metadata,
  sessionId,
}: {
  metadata: AttachmentMetadata;
  sessionId: string | null | undefined;
}) {
  const state = useAttachmentBytes(sessionId, metadata.id);
  const isImage = metadata.kind === 'image';
  const ready = state.status === 'ready' ? state.attachment : null;
  const [previewOpen, setPreviewOpen] = useState(false);

  // Thumbnail (image kind only) gets a small Blob URL just for the chip.
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!ready || !isImage) { setThumbUrl(null); return; }
    const blob = new Blob([base64ToBytes(ready.data) as BlobPart], { type: ready.mimeType });
    const url = URL.createObjectURL(blob);
    setThumbUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [ready, isImage]);

  const open = useCallback(() => { if (ready) setPreviewOpen(true); }, [ready]);
  const close = useCallback(() => setPreviewOpen(false), []);

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={!ready}
        className={`flex items-center gap-2 rounded-md border border-slate-500/30 bg-slate-700/40 px-2 py-1 text-xs text-left ${
          ready ? 'cursor-pointer hover:bg-slate-700/60' : 'cursor-default'
        }`}
        aria-label={ready ? `Preview ${metadata.name}` : metadata.name}
      >
        <div className="shrink-0 w-9 h-9 rounded overflow-hidden bg-slate-800 flex items-center justify-center">
          {isImage && thumbUrl ? (
            <img src={thumbUrl} alt={metadata.name} className="w-full h-full object-cover" />
          ) : (
            <KindIcon kind={metadata.kind} />
          )}
        </div>
        <div className="min-w-0 max-w-[14ch]">
          <div className="truncate font-medium text-slate-100" title={metadata.name}>
            {metadata.name}
          </div>
          <div className="text-[10px] text-slate-400">
            {state.status === 'loading' ? 'Loading…' : state.status === 'error' ? 'Unavailable' : formatBytes(metadata.size)}
          </div>
        </div>
      </button>
      {previewOpen && ready && <AttachmentPreview attachment={ready} onClose={close} />}
    </>
  );
}

function KindIcon({ kind }: { kind: AttachmentMetadata['kind'] }) {
  const symbol = kind === 'pdf' ? 'PDF' : kind === 'text' ? 'TXT' : 'IMG';
  return <span className="text-[9px] font-mono font-semibold text-slate-300">{symbol}</span>;
}
