import { useCallback, useEffect, useState } from 'react';
import {
  buildOfferMessage,
  getPushSupportStatus,
  notificationPermission,
  subscribe,
  type PushSupportStatus,
} from '../lib/pushSubscription';
import type { Message, PushSubscriptionOfferPayload } from '@sumicom/quicksave-shared';

export interface UseNotificationEnableResult {
  /** True when the browser supports push and a VAPID key is configured. */
  isSupported: boolean;
  /** Specific reason push is unavailable, or `{ ok: true }` when fully supported. */
  supportStatus: PushSupportStatus;
  /** Current browser permission state — refreshed after enable() and on mount. */
  permission: NotificationPermission;
  /** In-flight indicator for enable(). */
  busy: boolean;
  /** Last error message from enable(), cleared when enable() starts again. */
  error: string | null;
  /** Request permission, subscribe, and forward the offer envelope. */
  enable: () => Promise<void>;
}

/**
 * Shared wiring for the Web Push opt-in flow. Both the home-page banner and
 * the settings panel drive the same subscribe → offer sequence through this
 * hook so they stay in sync.
 */
export function useNotificationEnable(
  onOffer?: (msg: Message<PushSubscriptionOfferPayload>) => void
): UseNotificationEnableResult {
  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  const supportStatus = getPushSupportStatus(vapidPublicKey);
  const isSupported = supportStatus.ok;

  const [permission, setPermission] = useState<NotificationPermission>(() =>
    isSupported ? notificationPermission() : 'denied'
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Permission can change while the app runs (e.g. user flips it in browser settings).
  useEffect(() => {
    if (!isSupported || typeof document === 'undefined') return;
    const sync = () => setPermission(notificationPermission());
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [isSupported]);

  const enable = useCallback(async () => {
    if (!isSupported || !vapidPublicKey) return;
    setBusy(true);
    setError(null);
    try {
      const result = await subscribe({ vapidPublicKey });
      setPermission(notificationPermission());
      if (!result.ok) {
        if (result.reason !== 'permission-denied') {
          setError(result.error ?? result.reason);
        }
        return;
      }
      onOffer?.(buildOfferMessage(result.subscription));
    } finally {
      setBusy(false);
    }
  }, [isSupported, vapidPublicKey, onOffer]);

  return { isSupported, supportStatus, permission, busy, error, enable };
}
