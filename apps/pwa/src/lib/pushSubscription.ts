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
  const s = getPushSupportStatus(undefined);
  // Browser APIs present — VAPID is a config concern, not a capability one.
  return s.ok || s.kind === 'no-vapid-key';
}

export type PushSupportStatus =
  | { ok: true }
  | { ok: false; kind: 'no-browser-support'; detail: 'no-window' | 'no-service-worker' | 'no-notification-api' | 'no-push-manager' }
  | { ok: false; kind: 'ios-not-standalone' }
  | { ok: false; kind: 'no-vapid-key' };

/**
 * Report the first reason push isn't available, in the order a user can act on:
 * insecure/ancient browser → iOS needs home-screen install → missing VAPID config.
 * UI can show a specific hint per kind instead of a generic "unsupported".
 */
export function getPushSupportStatus(vapidPublicKey: string | undefined): PushSupportStatus {
  const w: Window | undefined = typeof window !== 'undefined' ? window : undefined;
  if (!w) {
    return { ok: false, kind: 'no-browser-support', detail: 'no-window' };
  }
  if (!('serviceWorker' in navigator)) {
    return { ok: false, kind: 'no-browser-support', detail: 'no-service-worker' };
  }
  if (typeof Notification === 'undefined') {
    return { ok: false, kind: 'no-browser-support', detail: 'no-notification-api' };
  }
  if (!('PushManager' in w)) {
    // iOS 16.4+ exposes PushManager only after the PWA is added to Home Screen.
    const nav = navigator as Navigator & { maxTouchPoints?: number };
    const isIOS = /iPad|iPhone|iPod/.test(nav.userAgent)
      || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
    const standalone = typeof w.matchMedia === 'function'
      && w.matchMedia('(display-mode: standalone)').matches;
    if (isIOS && !standalone) return { ok: false, kind: 'ios-not-standalone' };
    return { ok: false, kind: 'no-browser-support', detail: 'no-push-manager' };
  }
  if (!vapidPublicKey) return { ok: false, kind: 'no-vapid-key' };
  return { ok: true };
}

export function notificationPermission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  // `.ready` never resolves when no SW is registered (e.g. dev server without
  // VitePWA devOptions). Race against a timeout so the UI can surface an error
  // instead of sitting in "registering…" forever.
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
  const ready = await Promise.race([navigator.serviceWorker.ready, timeout]);
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
