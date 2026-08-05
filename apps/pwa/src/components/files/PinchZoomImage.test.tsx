// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clampZoomTransform, PinchZoomImage, transformForPinch } from './PinchZoomImage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pointerEvent(type: string, pointerId: number, clientX: number, clientY: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

describe('PinchZoomImage transforms', () => {
  it('zooms around the pinch center instead of jumping to the image center', () => {
    const result = transformForPinch(
      { scale: 1, x: 0, y: 0 },
      100,
      { x: 150, y: 100 },
      200,
      { x: 150, y: 100 },
      { x: 100, y: 100 },
    );

    expect(result).toEqual({ scale: 2, x: -50, y: 0 });
  });

  it('limits the zoom range to one through four times', () => {
    const zoomedOut = transformForPinch(
      { scale: 2, x: 0, y: 0 },
      100,
      { x: 0, y: 0 },
      10,
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    );
    const zoomedIn = transformForPinch(
      { scale: 2, x: 0, y: 0 },
      100,
      { x: 0, y: 0 },
      1_000,
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    );

    expect(zoomedOut.scale).toBe(1);
    expect(zoomedIn.scale).toBe(4);
  });

  it('keeps panning within the scaled image bounds and recenters at one times', () => {
    expect(clampZoomTransform(
      { scale: 2, x: 500, y: -500 },
      { width: 300, height: 200 },
      { width: 200, height: 150 },
    )).toEqual({ scale: 2, x: 50, y: -50 });

    expect(clampZoomTransform(
      { scale: 0.5, x: 20, y: 30 },
      { width: 300, height: 200 },
      { width: 200, height: 150 },
    )).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('PinchZoomImage gestures', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('updates the rendered image when two pointers pinch outward', async () => {
    await act(async () => {
      root.render(<PinchZoomImage src="image.png" alt="Preview" />);
    });
    const viewport = host.firstElementChild as HTMLDivElement;
    const image = viewport.querySelector('img') as HTMLImageElement;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 200 },
    });
    Object.defineProperties(image, {
      clientWidth: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 200 },
    });
    viewport.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 200,
      width: 200, height: 200, toJSON: () => ({}),
    });

    await act(async () => {
      viewport.dispatchEvent(pointerEvent('pointerdown', 1, 75, 100));
      viewport.dispatchEvent(pointerEvent('pointerdown', 2, 125, 100));
      viewport.dispatchEvent(pointerEvent('pointermove', 1, 50, 100));
      viewport.dispatchEvent(pointerEvent('pointermove', 2, 150, 100));
    });

    expect(image.style.transform).toContain('scale(2)');
    expect(viewport.querySelector('[aria-label="Reset image zoom"]')?.textContent).toBe('200%');
  });

  it('supports desktop zoom buttons', async () => {
    await act(async () => {
      root.render(<PinchZoomImage src="image.png" alt="Preview" />);
    });
    const viewport = host.firstElementChild as HTMLDivElement;
    const image = viewport.querySelector('img') as HTMLImageElement;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 200 },
    });
    Object.defineProperties(image, {
      clientWidth: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 200 },
    });

    await act(async () => {
      viewport.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click();
    });

    expect(image.style.transform).toContain('scale(1.5)');
    expect(viewport.querySelector('[aria-label="Reset image zoom"]')?.textContent).toBe('150%');
  });
});
