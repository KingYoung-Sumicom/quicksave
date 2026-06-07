// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useRef } from 'react';

type WakeLockSentinel = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
  removeEventListener: (type: 'release', listener: () => void) => void;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinel>;
  };
};

const DISABLE_STORAGE_KEY = 'quicksave:disableWakeLock';

function wakeLockEnabledByConfig(): boolean {
  if (import.meta.env.VITE_DISABLE_WAKE_LOCK === 'true') return false;
  try {
    return localStorage.getItem(DISABLE_STORAGE_KEY) !== 'true';
  } catch {
    return true;
  }
}

/**
 * Best-effort screen wake lock for hands-free voice use.
 *
 * Unsupported browsers (notably some iOS/PWA versions) quietly no-op. Browsers
 * can release the lock when the app is hidden, so this retries on foreground
 * resume paths. This prevents screen sleep while visible; it does not keep JS
 * running after iOS suspends a backgrounded PWA.
 */
export function useScreenWakeLock(enabled: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const requestingRef = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (typeof navigator === 'undefined' || typeof document === 'undefined') return;

    const release = () => {
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel && !sentinel.released) {
        void sentinel.release().catch(() => undefined);
      }
    };

    const request = async () => {
      if (!enabledRef.current || !wakeLockEnabledByConfig()) {
        release();
        return;
      }
      if (document.visibilityState !== 'visible') return;
      const wakeLock = (navigator as WakeLockNavigator).wakeLock;
      if (!wakeLock?.request) return;
      if (requestingRef.current || sentinelRef.current) return;
      requestingRef.current = true;
      try {
        const sentinel = await wakeLock.request('screen');
        if (!enabledRef.current || document.visibilityState !== 'visible') {
          await sentinel.release().catch(() => undefined);
          return;
        }
        sentinelRef.current = sentinel;
        const onRelease = () => {
          sentinel.removeEventListener('release', onRelease);
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
        };
        sentinel.addEventListener('release', onRelease);
      } catch {
        // Wake Lock is optional; denial/unsupported paths must not affect voice.
      } finally {
        requestingRef.current = false;
      }
    };

    const onForeground = () => {
      if (document.visibilityState === 'visible') void request();
      else release();
    };

    void request();
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('pageshow', onForeground);
    window.addEventListener('focus', onForeground);
    window.addEventListener('pagehide', release);

    return () => {
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('pageshow', onForeground);
      window.removeEventListener('focus', onForeground);
      window.removeEventListener('pagehide', release);
      release();
    };
  }, [enabled]);
}
