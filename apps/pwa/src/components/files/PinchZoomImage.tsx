// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';

const MIN_SCALE = 1;
const DEFAULT_MAX_SCALE = 4;
const ZOOM_STEP = 0.5;

export interface ZoomTransform {
  scale: number;
  x: number;
  y: number;
}

interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

export function clampZoomTransform(
  transform: ZoomTransform,
  viewport: Size,
  content: Size,
  maxScale = DEFAULT_MAX_SCALE,
): ZoomTransform {
  const scale = Math.min(maxScale, Math.max(MIN_SCALE, transform.scale));
  if (scale === MIN_SCALE) return { scale, x: 0, y: 0 };

  const maxX = Math.max(0, (content.width * scale - viewport.width) / 2);
  const maxY = Math.max(0, (content.height * scale - viewport.height) / 2);
  return {
    scale,
    x: Math.min(maxX, Math.max(-maxX, transform.x)),
    y: Math.min(maxY, Math.max(-maxY, transform.y)),
  };
}

export function transformForPinch(
  initial: ZoomTransform,
  initialDistance: number,
  initialCenter: Point,
  currentDistance: number,
  currentCenter: Point,
  viewportCenter: Point,
  maxScale = DEFAULT_MAX_SCALE,
): ZoomTransform {
  const scale = Math.min(
    maxScale,
    Math.max(MIN_SCALE, initial.scale * (currentDistance / Math.max(initialDistance, 1))),
  );
  const focalX = (initialCenter.x - viewportCenter.x - initial.x) / initial.scale;
  const focalY = (initialCenter.y - viewportCenter.y - initial.y) / initial.scale;

  return {
    scale,
    x: currentCenter.x - viewportCenter.x - focalX * scale,
    y: currentCenter.y - viewportCenter.y - focalY * scale,
  };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function PinchZoomImage({
  src,
  alt,
  imageClassName = '',
  className = '',
}: {
  src: string;
  alt: string;
  imageClassName?: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const fitSizeRef = useRef<Size | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const transformRef = useRef<ZoomTransform>({ scale: MIN_SCALE, x: 0, y: 0 });
  const maxScaleRef = useRef(DEFAULT_MAX_SCALE);
  const panStartRef = useRef<{ point: Point; transform: ZoomTransform } | null>(null);
  const pinchStartRef = useRef<{
    distance: number;
    center: Point;
    transform: ZoomTransform;
  } | null>(null);
  const [transform, setTransformState] = useState<ZoomTransform>(transformRef.current);
  const [fitSize, setFitSize] = useState<Size | null>(null);
  const [nativeScale, setNativeScale] = useState(MIN_SCALE);
  const [maxScale, setMaxScale] = useState(DEFAULT_MAX_SCALE);

  const refreshScaleLimits = useCallback(() => {
    const image = imageRef.current;
    if (!image || transformRef.current.scale !== MIN_SCALE
      || image.clientWidth <= 0 || image.clientHeight <= 0) return;
    const nextFitSize = { width: image.clientWidth, height: image.clientHeight };
    const nextNativeScale = Math.max(
      MIN_SCALE,
      image.naturalWidth / nextFitSize.width,
      image.naturalHeight / nextFitSize.height,
    );
    const nextMaxScale = Math.max(DEFAULT_MAX_SCALE, nextNativeScale);
    maxScaleRef.current = nextMaxScale;
    fitSizeRef.current = nextFitSize;
    setFitSize(nextFitSize);
    setNativeScale(nextNativeScale);
    setMaxScale(nextMaxScale);
  }, []);

  const setTransform = useCallback((next: ZoomTransform) => {
    const container = containerRef.current;
    const image = imageRef.current;
    const clamped = container && image
      ? clampZoomTransform(
          next,
          { width: container.clientWidth, height: container.clientHeight },
          fitSizeRef.current ?? { width: image.clientWidth, height: image.clientHeight },
          maxScaleRef.current,
        )
      : next;
    transformRef.current = clamped;
    setTransformState(clamped);
  }, []);

  const beginGesture = useCallback(() => {
    const points = [...pointersRef.current.values()];
    if (points.length >= 2) {
      pinchStartRef.current = {
        distance: distance(points[0], points[1]),
        center: midpoint(points[0], points[1]),
        transform: transformRef.current,
      };
      panStartRef.current = null;
    } else if (points.length === 1) {
      panStartRef.current = { point: points[0], transform: transformRef.current };
      pinchStartRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
    beginGesture();
  }, [beginGesture]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointersRef.current.values()];

    if (points.length >= 2 && pinchStartRef.current) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTransform(transformForPinch(
        pinchStartRef.current.transform,
        pinchStartRef.current.distance,
        pinchStartRef.current.center,
        distance(points[0], points[1]),
        midpoint(points[0], points[1]),
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        maxScaleRef.current,
      ));
      return;
    }

    if (points.length === 1 && panStartRef.current && transformRef.current.scale > MIN_SCALE) {
      setTransform({
        ...panStartRef.current.transform,
        x: panStartRef.current.transform.x + points[0].x - panStartRef.current.point.x,
        y: panStartRef.current.transform.y + points[0].y - panStartRef.current.point.y,
      });
    }
  }, [setTransform]);

  const endPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* unsupported */ }
    beginGesture();
  }, [beginGesture]);

  const reset = useCallback(() => {
    pointersRef.current.clear();
    panStartRef.current = null;
    pinchStartRef.current = null;
    setTransform({ scale: MIN_SCALE, x: 0, y: 0 });
  }, [setTransform]);

  useEffect(() => {
    fitSizeRef.current = null;
    maxScaleRef.current = DEFAULT_MAX_SCALE;
    setFitSize(null);
    setNativeScale(MIN_SCALE);
    setMaxScale(DEFAULT_MAX_SCALE);
    reset();
  }, [reset, src]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (transformRef.current.scale !== MIN_SCALE) return;
      requestAnimationFrame(refreshScaleLimits);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [refreshScaleLimits, src]);

  const zoomBy = useCallback((delta: number) => {
    setTransform({
      ...transformRef.current,
      scale: transformRef.current.scale + delta,
    });
  }, [setTransform]);

  const onWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }, [zoomBy]);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden touch-none ${transform.scale > MIN_SCALE ? 'cursor-grab active:cursor-grabbing' : ''} ${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onWheel={onWheel}
    >
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={refreshScaleLimits}
        className={`select-none shrink-0 ${imageClassName}`}
        style={{
          width: fitSize && transform.scale > MIN_SCALE ? `${fitSize.width * transform.scale}px` : undefined,
          height: fitSize && transform.scale > MIN_SCALE ? `${fitSize.height * transform.scale}px` : undefined,
          maxWidth: fitSize && transform.scale > MIN_SCALE ? 'none' : undefined,
          maxHeight: fitSize && transform.scale > MIN_SCALE ? 'none' : undefined,
          transform: fitSize
            ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
            : `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          transformOrigin: 'center',
        }}
      />
      <div
        className="absolute right-3 top-3 hidden h-8 items-stretch overflow-hidden rounded border border-slate-600 bg-slate-900/85 text-slate-100 shadow-md backdrop-blur md:flex"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => zoomBy(-ZOOM_STEP)}
          disabled={transform.scale <= MIN_SCALE}
          className="flex w-8 items-center justify-center text-lg hover:bg-slate-700 disabled:opacity-35"
          aria-label="Zoom out"
          title="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          onClick={reset}
          className="min-w-14 border-x border-slate-600 px-2 text-xs hover:bg-slate-700"
          aria-label="Reset image zoom"
          title="Reset zoom"
        >
          {Math.round(transform.scale * 100)}%
        </button>
        <button
          type="button"
          onClick={() => setTransform({ scale: nativeScale, x: 0, y: 0 })}
          disabled={Math.abs(nativeScale - MIN_SCALE) < 0.01}
          className="min-w-10 border-r border-slate-600 px-2 text-xs hover:bg-slate-700 disabled:opacity-35"
          aria-label="Show actual pixels"
          title="Show at original pixel size"
        >
          1:1
        </button>
        <button
          type="button"
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={transform.scale >= maxScale}
          className="flex w-8 items-center justify-center text-lg hover:bg-slate-700 disabled:opacity-35"
          aria-label="Zoom in"
          title="Zoom in"
        >
          +
        </button>
      </div>
      <div
        className="absolute right-3 top-3 flex h-8 items-stretch overflow-hidden rounded border border-slate-600 bg-slate-900/85 text-xs text-slate-100 shadow-md backdrop-blur md:hidden"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={reset}
          disabled={transform.scale <= MIN_SCALE}
          className="min-w-12 px-2 disabled:opacity-50"
          aria-label="Reset image zoom"
          title="Fit image"
        >
          {Math.round(transform.scale * 100)}%
        </button>
        <button
          type="button"
          onClick={() => setTransform({ scale: nativeScale, x: 0, y: 0 })}
          disabled={Math.abs(nativeScale - MIN_SCALE) < 0.01}
          className="min-w-10 border-l border-slate-600 px-2 disabled:opacity-50"
          aria-label="Show actual pixels"
          title="Show at original pixel size"
        >
          1:1
        </button>
      </div>
    </div>
  );
}
