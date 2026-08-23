// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FilesReadResponsePayload } from '@sumicom/quicksave-shared';
import { useFileOps } from '../../hooks/useFileOps';
import { getBusForAgent } from '../../lib/busRegistry';
import { useClaudeStore } from '../../stores/claudeStore';
import { useFilePreviewStore } from '../../stores/filePreviewStore';
import { Spinner } from '../ui/Spinner';

const DIRECT_IMAGE_SCHEME_RE = /^(?:https?:|data:|blob:|\/\/)/i;

export function isDirectImageSource(src: string): boolean {
  return DIRECT_IMAGE_SCHEME_RE.test(src);
}

/** The Markdown sanitizer blocks `file:` by default. Permit only local-host
 * file URLs for image nodes; they are still fetched through `files:read`. */
export function isLocalFileUrl(src: string): boolean {
  return /^file:\/\/(?:localhost)?\//i.test(src);
}

/** Convert a Markdown image URL into the path understood by `files:read`. */
export function localImagePath(src: string): string {
  const withoutSuffix = stripQueryAndHash(src);
  if (/^file:\/\//i.test(withoutSuffix)) {
    try {
      const url = new URL(withoutSuffix);
      if (url.hostname && url.hostname !== 'localhost') return withoutSuffix;
      return decodePath(url.pathname);
    } catch {
      return withoutSuffix;
    }
  }
  return decodePath(withoutSuffix);
}

export function LocalFileImage({
  src,
  alt,
  title,
  cwd: cwdOverride,
  baseDir,
  agentId: agentIdOverride,
  className = 'max-w-full h-auto rounded my-2',
}: {
  src: string;
  alt: string;
  title?: string;
  cwd?: string;
  baseDir?: string;
  agentId?: string;
  className?: string;
}) {
  const activeSession = useClaudeStore((state) => {
    const id = state.activeSessionId;
    return id ? state.sessions[id] : undefined;
  });
  const cwd = cwdOverride ?? activeSession?.cwd ?? '';
  const agentId = agentIdOverride ?? activeSession?.machineAgentId ?? '';
  const getBus = useCallback(() => getBusForAgent(agentId), [agentId]);
  const { readFile } = useFileOps(getBus, { queueWhileDisconnected: false });
  const openPreview = useFilePreviewStore((state) => state.open);
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; url: string }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const requestId = useRef(0);

  const path = useMemo(() => {
    const localPath = localImagePath(src);
    return baseDir ? resolveAgainst(baseDir, localPath) : localPath;
  }, [baseDir, src]);

  useEffect(() => {
    setState({ kind: 'loading' });
    const currentRequest = ++requestId.current;
    const isSvg = /\.svg$/i.test(path);

    readFile({ cwd, path, allowImage: !isSvg })
      .then((response: FilesReadResponsePayload) => {
        if (currentRequest !== requestId.current) return;
        if (!response.success) {
          setState({ kind: 'error', message: response.error ?? 'Failed to load image' });
          return;
        }
        if (response.kind === 'image' && response.content && response.encoding === 'base64' && response.mimeType) {
          setState({ kind: 'ok', url: `data:${response.mimeType};base64,${response.content}` });
          return;
        }
        if (isSvg && response.kind === 'text' && typeof response.content === 'string') {
          setState({ kind: 'ok', url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(response.content)}` });
          return;
        }
        if (response.kind === 'oversized') {
          setState({ kind: 'error', message: response.transferError ?? 'Image exceeds the preview limit' });
          return;
        }
        setState({ kind: 'error', message: 'Unsupported image format' });
      })
      .catch((error) => {
        if (currentRequest !== requestId.current) return;
        setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      });
  }, [cwd, path, readFile]);

  if (state.kind === 'loading') {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-slate-500 my-1" title={path}>
        <Spinner size="w-3 h-3" color="border-slate-400" />
        loading image…
      </span>
    );
  }

  if (state.kind === 'error') {
    return (
      <span className="inline-block text-xs text-amber-400 my-1" title={path}>
        [image: {alt || src} — {state.message}]
      </span>
    );
  }

  return (
    <button
      type="button"
      className="block max-w-full cursor-zoom-in appearance-none border-0 bg-transparent p-0 text-left"
      onClick={(event) => {
        event.stopPropagation();
        openPreview({ cwd, path, agentId });
      }}
      aria-label={`Preview ${alt || fileNameOf(path)}`}
    >
      <img src={state.url} alt={alt} title={title ?? (alt || fileNameOf(path))} className={className} />
    </button>
  );
}

function stripQueryAndHash(value: string): string {
  const query = value.indexOf('?');
  const hash = value.indexOf('#');
  const index = query < 0 ? hash : hash < 0 ? query : Math.min(query, hash);
  return index < 0 ? value : value.slice(0, index);
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveAgainst(dir: string, target: string): string {
  if (target.startsWith('/')) return collapseDots(target);
  return collapseDots(`${dir}/${target}`);
}

function collapseDots(path: string): string {
  const output: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      if (output.length === 0 && segment === '') output.push('');
      continue;
    }
    if (segment === '..') {
      if (output.length > 1 || (output.length === 1 && output[0] !== '')) output.pop();
      continue;
    }
    output.push(segment);
  }
  return output.join('/') || '/';
}

function fileNameOf(path: string): string {
  return path.split('/').pop() || path;
}
