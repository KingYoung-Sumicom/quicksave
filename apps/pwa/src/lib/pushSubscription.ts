/**
 * Browser-side Web Push subscription lifecycle.
 *
 * The actual push delivery lives on the relay; this file only talks to the
 * browser + service worker. Call sites compose this with `WebSocketClient` to
 * forward the resulting subscription to the agent as a
 * `push:subscription-offer` message.
 */

import type { Message, PushSubscriptionOfferPayload } from '@sumicom/quicksave-shared';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function isPushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && typeof Notification !== 'undefined';
}

export function notificationPermission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  const ready = await navigator.serviceWorker.ready;
  return ready ?? null;
}

export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  const reg = await getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

export interface SubscribeOptions {
  vapidPublicKey: string;
  /** If true, skip the permission prompt when it's already in 'default' state. */
  requirePermissionGranted?: boolean;
}

export type SubscribeResult =
  | { ok: true; subscription: PushSubscription }
  | { ok: false; reason: 'unsupported' | 'permission-denied' | 'no-sw' | 'subscribe-failed'; error?: string };

export async function subscribe(opts: SubscribeOptions): Promise<SubscribeResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  let permission = Notification.permission;
  if (permission === 'default' && !opts.requirePermissionGranted) {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') return { ok: false, reason: 'permission-denied' };

  const reg = await getRegistration();
  if (!reg) return { ok: false, reason: 'no-sw' };

  try {
    const existing = await reg.pushManager.getSubscription();
    if (existing) return { ok: true, subscription: existing };

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // TS' Uint8Array<ArrayBufferLike> doesn't satisfy BufferSource<ArrayBuffer> in newer lib.dom —
      // the runtime only needs the raw bytes, so the cast is safe.
      applicationServerKey: urlBase64ToUint8Array(opts.vapidPublicKey) as unknown as BufferSource,
    });
    return { ok: true, subscription };
  } catch (err) {
    return {
      ok: false,
      reason: 'subscribe-failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function unsubscribe(): Promise<boolean> {
  const sub = await getCurrentSubscription();
  if (!sub) return false;
  return sub.unsubscribe();
}

/** Convert a browser PushSubscription to the payload the agent understands. */
export function toOfferPayload(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const json = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  return {
    endpoint: json.endpoint ?? subscription.endpoint,
    keys: {
      p256dh: json.keys?.p256dh ?? '',
      auth: json.keys?.auth ?? '',
    },
  };
}

/** Build the WS message sent to the agent to register this subscription. */
export function buildOfferMessage(
  subscription: PushSubscription,
  relayHttpUrl?: string,
): Message<PushSubscriptionOfferPayload> {
  const payload: PushSubscriptionOfferPayload = {
    subscription: toOfferPayload(subscription),
    ...(relayHttpUrl ? { relayHttpUrl } : {}),
  };
  return {
    id: `push-offer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'push:subscription-offer',
    payload,
    timestamp: Date.now(),
  };
}
