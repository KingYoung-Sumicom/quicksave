// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { FilesReadResponsePayload } from '@sumicom/quicksave-shared';
import { clampZoomTransform, transformForPinch, type ZoomTransform } from './PinchZoomImage';

interface OutlineEntry { title: string; page?: number; depth: number }
interface PdfOutlineNode { title: string; dest: string | unknown[] | null; items: PdfOutlineNode[] }

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function pageForDestination(document: PDFDocumentProxy, destination: string | unknown[] | null): Promise<number | undefined> {
  const resolved = typeof destination === 'string' ? await document.getDestination(destination) : destination;
  if (!Array.isArray(resolved) || !resolved[0] || typeof resolved[0] !== 'object') return undefined;
  const ref = resolved[0] as { num?: number; gen?: number };
  if (typeof ref.num !== 'number' || typeof ref.gen !== 'number') return undefined;
  return (await document.getPageIndex({ num: ref.num, gen: ref.gen })) + 1;
}

async function flattenOutline(document: PDFDocumentProxy, items: PdfOutlineNode[] | null, depth = 0): Promise<OutlineEntry[]> {
  if (!items) return [];
  const result: OutlineEntry[] = [];
  for (const item of items) {
    const page = await pageForDestination(document, item.dest);
    if (item.title) result.push({ title: item.title, page, depth });
    result.push(...await flattenOutline(document, item.items, depth + 1));
  }
  return result;
}

export function PdfViewer({ data }: { data: FilesReadResponsePayload }) {
  const [state, setState] = useState<{ document: PDFDocumentProxy; outline: OutlineEntry[] } | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.25);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bytes = useMemo(() => data.content ? base64ToBytes(data.content) : null, [data.content]);

  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    let destroyLoading: (() => void) | null = null;
    void import('pdfjs-dist').then(({ GlobalWorkerOptions, getDocument }) => {
      if (cancelled) return;
      GlobalWorkerOptions.workerSrc = workerSrc;
      const loadingTask = getDocument({ data: bytes });
      destroyLoading = () => { void loadingTask.destroy(); };
      return loadingTask.promise.then(async (document) => {
        const outline = await flattenOutline(document, await document.getOutline() as PdfOutlineNode[] | null);
        if (cancelled) { await document.destroy(); return; }
        setState({ document, outline });
        setPageNumber(1);
        setError(null);
      });
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setState(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
      destroyLoading?.();
    };
  }, [bytes]);

  useEffect(() => () => {
    if (state?.document) void state.document.destroy();
  }, [state?.document]);

  if (!bytes) return <div className="p-6 text-center text-amber-400">PDF data is unavailable.</div>;
  if (error) return <div className="p-6 text-center text-red-400">Unable to render PDF: {error}</div>;
  if (!state) return <div className="p-6 text-center text-slate-400">Loading PDF…</div>;

  const pageCount = state.document.numPages;
  return (
    <div className="flex h-full min-h-0 select-none flex-col bg-slate-950" style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300">
        <button type="button" onClick={() => setOutlineOpen((open) => !open)} className="rounded px-2 py-1 hover:bg-slate-700">{outlineOpen ? '隱藏大綱' : '顯示大綱'}</button>
        <button type="button" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)} className="rounded px-2 py-1 hover:bg-slate-700 disabled:opacity-30">上一頁</button>
        <span className="min-w-20 text-center">{pageNumber} / {pageCount}</span>
        <button type="button" disabled={pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)} className="rounded px-2 py-1 hover:bg-slate-700 disabled:opacity-30">下一頁</button>
        <span className="ml-auto">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => setScale((value) => Math.max(0.6, value - 0.15))} className="rounded px-2 py-1 hover:bg-slate-700">−</button>
        <button type="button" onClick={() => setScale((value) => Math.min(3, value + 0.15))} className="rounded px-2 py-1 hover:bg-slate-700">＋</button>
      </div>
      <div className="flex min-h-0 flex-1">
        {outlineOpen && state.outline.length > 0 && (
          <nav className="w-56 shrink-0 overflow-y-auto border-r border-slate-700 bg-slate-900 p-2" aria-label="PDF 目錄大綱">
            {state.outline.map((entry, index) => (
              <button key={`${entry.title}-${index}`} type="button" disabled={entry.page === undefined} onClick={() => entry.page !== undefined && setPageNumber(Math.max(1, Math.min(pageCount, entry.page)))} className="block w-full truncate rounded px-2 py-1 text-left text-xs text-slate-300 hover:bg-slate-700 hover:text-white disabled:cursor-default disabled:opacity-70" style={{ paddingLeft: `${8 + entry.depth * 14}px` }} title={entry.title}>{entry.title}</button>
            ))}
          </nav>
        )}
        <div className="min-h-0 flex-1 overflow-hidden p-4"><PdfPage
          document={state.document}
          pageNumber={pageNumber}
          scale={scale}
          onPrevious={() => setPageNumber((page) => Math.max(1, page - 1))}
          onNext={() => setPageNumber((page) => Math.min(pageCount, page + 1))}
        /></div>
      </div>
    </div>
  );
}

export function pageSwipeDirection(deltaX: number, deltaY: number, threshold = 56): -1 | 0 | 1 {
  if (Math.abs(deltaX) < threshold || Math.abs(deltaX) <= Math.abs(deltaY) * 1.15) return 0;
  return deltaX < 0 ? 1 : -1;
}

interface Point { x: number; y: number }
interface Size { width: number; height: number }

function PdfPage({
  document,
  pageNumber,
  scale,
  onPrevious,
  onNext,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const transformRef = useRef<ZoomTransform>({ scale: 1, x: 0, y: 0 });
  const displaySizeRef = useRef<Size | null>(null);
  const gestureStartRef = useRef<{ point: Point; transform: ZoomTransform } | null>(null);
  const pinchStartRef = useRef<{ distance: number; center: Point; transform: ZoomTransform } | null>(null);
  const swipeStartRef = useRef<Point | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState<Size | null>(null);
  const [displaySize, setDisplaySize] = useState<Size | null>(null);
  const [transform, setTransform] = useState<ZoomTransform>(transformRef.current);
  const [renderQuality, setRenderQuality] = useState(1);

  const refreshDisplaySize = () => {
    const viewport = viewportRef.current;
    if (!viewport || !canvasSize || viewport.clientWidth <= 0) return;
    const widthRatio = viewport.clientWidth / canvasSize.width;
    const heightRatio = viewport.clientHeight > 0 ? viewport.clientHeight / canvasSize.height : widthRatio;
    const fitScale = Math.min(1, widthRatio, heightRatio);
    const nextSize = { width: canvasSize.width * fitScale, height: canvasSize.height * fitScale };
    displaySizeRef.current = nextSize;
    setDisplaySize(nextSize);
    if (transformRef.current.scale === 1) updateTransform({ scale: 1, x: 0, y: 0 });
  };

  const updateTransform = (next: ZoomTransform) => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    const content = displaySizeRef.current ?? canvasSize ?? (canvas ? { width: canvas.width, height: canvas.height } : null);
    const clamped = viewport && content
      ? clampZoomTransform(next, { width: viewport.clientWidth, height: viewport.clientHeight }, content)
      : next;
    transformRef.current = clamped;
    setTransform(clamped);
  };

  const resetGesture = () => {
    pointersRef.current.clear();
    gestureStartRef.current = null;
    pinchStartRef.current = null;
    swipeStartRef.current = null;
    setSwipeOffset(0);
    updateTransform({ scale: 1, x: 0, y: 0 });
  };

  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, point);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
    const points = [...pointersRef.current.values()];
    if (points.length >= 2) {
      setSwipeOffset(0);
      pinchStartRef.current = {
        distance: distance(points[0], points[1]),
        center: midpoint(points[0], points[1]),
        transform: transformRef.current,
      };
      gestureStartRef.current = null;
      swipeStartRef.current = null;
    } else {
      gestureStartRef.current = { point, transform: transformRef.current };
      swipeStartRef.current = point;
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const point = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, point);
    const points = [...pointersRef.current.values()];
    if (points.length >= 2 && pinchStartRef.current) {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      updateTransform(transformForPinch(
        pinchStartRef.current.transform,
        pinchStartRef.current.distance,
        pinchStartRef.current.center,
        distance(points[0], points[1]),
        midpoint(points[0], points[1]),
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        4,
        0.7,
      ));
    } else if (points.length === 1 && gestureStartRef.current && transformRef.current.scale > 1) {
      updateTransform({
        ...gestureStartRef.current.transform,
        x: gestureStartRef.current.transform.x + point.x - gestureStartRef.current.point.x,
        y: gestureStartRef.current.transform.y + point.y - gestureStartRef.current.point.y,
      });
    } else if (points.length === 1 && swipeStartRef.current && transformRef.current.scale === 1) {
      setSwipeOffset(point.x - swipeStartRef.current.x);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = pointersRef.current.get(event.pointerId);
    const wasSinglePointer = pointersRef.current.size === 1;
    if (point && wasSinglePointer && swipeStartRef.current && transformRef.current.scale === 1) {
      const direction = pageSwipeDirection(point.x - swipeStartRef.current.x, point.y - swipeStartRef.current.y);
      setSwipeOffset(0);
      if (direction < 0) onPrevious();
      if (direction > 0) onNext();
    }
    pointersRef.current.delete(event.pointerId);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* unsupported */ }
    if (pointersRef.current.size >= 2) {
      const points = [...pointersRef.current.values()];
      pinchStartRef.current = { distance: distance(points[0], points[1]), center: midpoint(points[0], points[1]), transform: transformRef.current };
    } else if (pointersRef.current.size === 1) {
      const remaining = [...pointersRef.current.values()][0];
      gestureStartRef.current = { point: remaining, transform: transformRef.current };
      swipeStartRef.current = null;
      setSwipeOffset(0);
      pinchStartRef.current = null;
    } else {
      gestureStartRef.current = null;
      pinchStartRef.current = null;
      swipeStartRef.current = null;
      setSwipeOffset(0);
    }
  };

  useEffect(() => {
    const nextQuality = Math.min(4, Math.max(1, Math.ceil(transform.scale)));
    setRenderQuality((current) => current === nextQuality ? current : nextQuality);
  }, [transform.scale]);

  useEffect(() => {
    resetGesture();
    displaySizeRef.current = null;
    setCanvasSize(null);
    setDisplaySize(null);
    setRenderQuality(1);
  // The gesture reset belongs to a page/toolbar-scale change, not every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, pageNumber, scale]);

  useEffect(() => {
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null;
    void document.getPage(pageNumber).then((loadedPage) => {
      page = loadedPage;
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const viewport = loadedPage.getViewport({ scale });
      const pixelRatio = typeof window === 'undefined'
        ? 1
        : Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const maxQuality = 4096 / (Math.max(viewport.width, viewport.height) * pixelRatio);
      const renderViewport = loadedPage.getViewport({
        scale: scale * pixelRatio * Math.max(1, Math.min(renderQuality, maxQuality)),
      });
      canvas.width = renderViewport.width;
      canvas.height = renderViewport.height;
      setCanvasSize({ width: viewport.width, height: viewport.height });
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is unavailable.');
      renderTask = loadedPage.render({ canvas, canvasContext: context, viewport: renderViewport });
      return renderTask.promise;
    }).then(() => { if (!cancelled) setError(null); }).catch((reason: unknown) => {
      if (!cancelled && !(reason instanceof Error && reason.name === 'RenderingCancelledException')) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      page?.cleanup();
    };
  }, [document, pageNumber, scale, renderQuality]);

  useEffect(() => {
    refreshDisplaySize();
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(refreshDisplaySize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [canvasSize]);

  if (error) return <div className="py-12 text-center text-red-400">{error}</div>;
  return (
    <div
      ref={viewportRef}
      className="relative flex h-full min-h-0 min-w-full items-center justify-center overflow-hidden touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-label={`PDF 第 ${pageNumber} 頁，可雙指縮放或左右滑動翻頁`}
    >
      <canvas
        ref={canvasRef}
        className="block shrink-0 select-none shadow-lg"
        aria-label={`PDF 第 ${pageNumber} 頁`}
        style={{
          width: displaySize ? `${displaySize.width}px` : undefined,
          height: displaySize ? `${displaySize.height}px` : undefined,
          maxWidth: 'none',
          transform: `translate3d(${transform.x + swipeOffset}px, ${transform.y}px, 0) scale(${transform.scale})`,
          transformOrigin: 'center',
        }}
      />
    </div>
  );
}
