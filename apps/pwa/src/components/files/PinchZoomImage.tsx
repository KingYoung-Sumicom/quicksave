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
const MAX_SCALE = 4;
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
): ZoomTransform {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale));
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
): ZoomTransform {
  const scale = Math.min(
    MAX_SCALE,
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
  const pointersRef = useRef(new Map<number, Point>());
  const transformRef = useRef<ZoomTransform>({ scale: MIN_SCALE, x: 0, y: 0 });
  const panStartRef = useRef<{ point: Point; transform: ZoomTransform } | null>(null);
  const pinchStartRef = useRef<{
    distance: number;
    center: Point;
    transform: ZoomTransform;
  } | null>(null);
  const [transform, setTransformState] = useState<ZoomTransform>(transformRef.current);

  const setTransform = useCallback((next: ZoomTransform) => {
    const container = containerRef.current;
    const image = imageRef.current;
    const clamped = container && image
      ? clampZoomTransform(
          next,
          { width: container.clientWidth, height: container.clientHeight },
          { width: image.clientWidth, height: image.clientHeight },
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
    reset();
  }, [reset, src]);

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
        className={`select-none ${imageClassName}`}
        style={{
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
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
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={transform.scale >= MAX_SCALE}
          className="flex w-8 items-center justify-center text-lg hover:bg-slate-700 disabled:opacity-35"
          aria-label="Zoom in"
          title="Zoom in"
        >
          +
        </button>
      </div>
      {transform.scale > MIN_SCALE && (
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={reset}
          className="absolute right-3 top-3 rounded-full bg-slate-900/75 px-2.5 py-1 text-xs text-slate-100 shadow-md backdrop-blur md:hidden"
          aria-label="Reset image zoom"
          title="Reset zoom"
        >
          {Math.round(transform.scale * 100)}%
        </button>
      )}
    </div>
  );
}
