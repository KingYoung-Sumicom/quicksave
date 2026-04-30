// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
  __WB_DISABLE_DEV_LOGS?: boolean;
};

// In Vite dev, __WB_MANIFEST is populated with un-hashed /src/* and Vite-dep
// URLs that will never be requested as-is (the browser hits them with ?v=
// query strings or via HMR), so precacheAndRoute floods the console with
// "No route found" warnings. Skip precaching entirely in dev and silence
// any remaining workbox dev-log chatter.
self.__WB_DISABLE_DEV_LOGS = true;
if (import.meta.env.PROD) {
  cleanupOutdatedCaches();
  precacheAndRoute(self.__WB_MANIFEST);
}

interface PushPayload {
  title?: string;
  body?: string;
  sessionId?: string;
  agentId?: string;
  url?: string;
  tag?: string;
}

self.addEventListener('push', (event: PushEvent) => {
  let payload: PushPayload = {};
  if (event.data) {
    try { payload = event.data.json() as PushPayload; }
    catch { payload = { body: event.data.text() }; }
  }

  const title = payload.title ?? 'Quicksave';
  const body = payload.body ?? '';
  const tag = payload.tag ?? payload.sessionId ?? 'quicksave-generic';
  const url = payload.url ?? '/';

  // `renotify` is widely supported by browsers but still missing from TS DOM lib.
  const options: NotificationOptions & { renotify?: boolean } = {
    body,
    tag,
    renotify: true,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    data: { url, sessionId: payload.sessionId, agentId: payload.agentId },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | undefined;
  const target = data?.url ?? '/';

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      // Any open PWA window: focus it and navigate.
      if ('focus' in client) {
        try { await client.focus(); } catch { /* focus can fail on background tabs */ }
        try { (client as WindowClient).navigate(target); }
        catch { /* cross-origin navigate rejected — fall through */ }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// Let the page trigger SKIP_WAITING for zero-downtime updates.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string })?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});
