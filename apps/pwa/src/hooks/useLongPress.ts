// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useRef, useCallback, useEffect } from 'react';

interface UseLongPressOptions {
  /** Delay in ms before long press fires (default 500) */
  delay?: number;
}

interface UseLongPressResult {
  /** Spread onto the target element */
  handlers: {
    onMouseDown: () => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
    onTouchStart: () => void;
    onTouchEnd: () => void;
    onTouchMove: () => void;
    onTouchCancel: () => void;
  };
  /** Call inside onClick — returns true if this click should be suppressed (was a long press) */
  wasLongPress: () => boolean;
}

/**
 * Detects long-press (press-and-hold) gestures on both mouse and touch.
 * Returns handlers to spread onto the element, plus a `wasLongPress()` guard
 * to suppress the normal click when a long press just fired.
 */
export function useLongPress(
  onLongPress: () => void,
  { delay = 500 }: UseLongPressOptions = {},
): UseLongPressResult {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);

  const start = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    fired.current = false;
    timer.current = setTimeout(() => {
      fired.current = true;
      onLongPress();
    }, delay);
  }, [onLongPress, delay]);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const wasLongPress = useCallback(() => {
    if (fired.current) {
      fired.current = false;
      return true;
    }
    return false;
  }, []);

  // Cancel any pending timer when the page is hidden (e.g. iOS app switch).
  // Without this, a spurious touchstart from the return gesture can leave a
  // leaked timer that fires 500 ms later and sets fired.current = true,
  // which then suppresses the next real click via wasLongPress().
  useEffect(() => {
    const onHide = () => cancel();
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [cancel]);

  return {
    handlers: {
      onMouseDown: start,
      onMouseUp: cancel,
      onMouseLeave: cancel,
      onTouchStart: start,
      onTouchEnd: cancel,
      onTouchMove: cancel,
      onTouchCancel: cancel,
    },
    wasLongPress,
  };
}
