// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScreenWakeLock } from './useScreenWakeLock';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ enabled }: { enabled: boolean }) {
  useScreenWakeLock(enabled);
  return null;
}

describe('useScreenWakeLock', () => {
  let container: HTMLDivElement;
  let root: Root;
  let release: ReturnType<typeof vi.fn>;
  let request: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    release = vi.fn(async () => undefined);
    request = vi.fn(async () => ({
      released: false,
      release,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request },
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    localStorage.clear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('requests a screen wake lock while enabled and releases it on disable', async () => {
    await act(async () => {
      root.render(<Harness enabled />);
    });

    expect(request).toHaveBeenCalledWith('screen');

    await act(async () => {
      root.render(<Harness enabled={false} />);
    });

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('quietly skips unsupported or disabled wake lock paths', async () => {
    localStorage.setItem('quicksave:disableWakeLock', 'true');

    await act(async () => {
      root.render(<Harness enabled />);
    });

    expect(request).not.toHaveBeenCalled();
  });

  it('retries when the page returns to the foreground', async () => {
    await act(async () => {
      root.render(<Harness enabled />);
    });

    expect(request).toHaveBeenCalledTimes(1);
    release.mockClear();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(release).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
    });

    expect(request).toHaveBeenCalledTimes(2);
  });
});
