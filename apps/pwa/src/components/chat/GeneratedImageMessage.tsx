// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FilesReadResponsePayload, GeneratedImageCard } from '@sumicom/quicksave-shared';
import { getBusForAgent } from '../../lib/busRegistry';
import { useFileOps } from '../../hooks/useFileOps';
import { useFilePreviewStore } from '../../stores/filePreviewStore';

function dataUrl(data: FilesReadResponsePayload | null): string | null {
  if (!data) return null;
  if (data.kind !== 'image' || data.encoding !== 'base64' || !data.content || !data.mimeType) return null;
  return `data:${data.mimeType};base64,${data.content}`;
}

function fileNameOf(path: string): string {
  return path.split('/').pop() || path;
}

export function GeneratedImageMessage({
  card,
  agentId,
}: {
  card: GeneratedImageCard;
  agentId: string;
}) {
  const getBus = useCallback(() => getBusForAgent(agentId), [agentId]);
  const { readFile } = useFileOps(getBus);
  const openPreview = useFilePreviewStore((s) => s.open);
  const [data, setData] = useState<FilesReadResponsePayload | null>(null);
  const hasImagePath = !!card.savedPath;
  const [loading, setLoading] = useState(hasImagePath);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!card.savedPath) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    readFile({ cwd: '', path: card.savedPath, allowImage: true })
      .then((res) => {
        if (cancelled) return;
        if (!res.success) {
          setError(res.error ?? 'Failed to load generated image');
          setData(null);
          return;
        }
        setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [card.savedPath, card.status, readFile]);

  const src = useMemo(() => dataUrl(data), [data]);
  const title = card.savedPath ? fileNameOf(card.savedPath) : 'Generated image';
  const canPreview = hasImagePath;

  const openFullPreview = useCallback(() => {
    if (!canPreview || !card.savedPath) return;
    openPreview({ cwd: '', path: card.savedPath, agentId });
  }, [agentId, canPreview, card.savedPath, openPreview]);

  if (card.status === 'running' && !hasImagePath) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2 text-sm text-slate-300">
        Generating image...
      </div>
    );
  }

  if (card.status === 'failed' && !hasImagePath) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
        Image generation failed
      </div>
    );
  }

  return (
    <div className="w-full py-1">
      <button
        type="button"
        onClick={openFullPreview}
        disabled={!canPreview}
        className="group block w-full max-w-2xl overflow-hidden rounded-lg border border-slate-700 bg-slate-800/50 text-left transition-colors hover:border-slate-500 disabled:cursor-default disabled:hover:border-slate-700"
        aria-label={`Preview ${title}`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-700 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-slate-100">{title}</div>
            {card.prompt && (
              <div className="truncate text-[11px] text-slate-400" title={card.prompt}>{card.prompt}</div>
            )}
          </div>
          <span className="shrink-0 text-[11px] text-slate-500 group-hover:text-slate-300">Open</span>
        </div>
        <div className="flex min-h-48 items-center justify-center bg-slate-950">
          {loading && <div className="text-xs text-slate-500">Loading image...</div>}
          {!loading && error && <div className="px-3 py-8 text-sm text-red-300">{error}</div>}
          {!loading && !error && src && (
            <img src={src} alt={card.prompt || title} className="max-h-[60vh] w-full object-contain" />
          )}
          {!loading && !error && !src && (
            <div className="px-3 py-8 text-sm text-slate-400">Generated image saved at {card.savedPath}</div>
          )}
        </div>
      </button>
    </div>
  );
}
