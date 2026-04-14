# Web Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send browser push notifications when the agent needs user input (permission prompt, question), even when the PWA tab is backgrounded or closed. Targets desktop Chrome, Android Chrome, and iOS Safari (16.4+).

**Architecture:** Option A (relay-mediated). The agent sends a minimal notification request through the existing WebSocket to the relay. The relay stores push subscriptions per PWA peer and dispatches Web Push API calls when the agent signals a pending input. Payload is minimal (type + sessionId) — no sensitive content leaves the relay. The PWA registers a custom service worker that handles `push` events and shows notifications with deep links to the relevant session.

**Tech Stack:** Web Push API, `web-push` npm package (relay), `vite-plugin-pwa` with custom SW injection (PWA), VAPID key pair (generated once).

---

## VAPID Keys

Generate once before starting:

```bash
npx web-push generate-vapid-keys
```

Store the public key in PWA env (`VITE_VAPID_PUBLIC_KEY`) and both keys in relay env (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`). In production, set via deploy secrets.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `apps/relay/src/pushStore.ts` | **NEW** — In-memory store for push subscriptions keyed by PWA peer address |
| `apps/relay/src/pushService.ts` | **NEW** — Web Push API wrapper using `web-push` package |
| `apps/relay/src/index.ts` | **MODIFY** — Handle `push:subscribe`, `push:unsubscribe` messages + trigger push on `notify-push` from agent |
| `apps/pwa/src/sw-custom.ts` | **NEW** — Custom service worker code: `push` event handler, `notificationclick` handler |
| `apps/pwa/src/lib/pushSubscription.ts` | **NEW** — Push subscription management: requestPermission, subscribe, send subscription to relay |
| `apps/pwa/src/components/NotificationPrompt.tsx` | **NEW** — UI component to request notification permission |
| `apps/pwa/vite.config.ts` | **MODIFY** — Add `injectManifest` strategy with custom SW entry |
| `apps/agent/src/service/run.ts` | **MODIFY** — On `user-input-request` with no connected PWA peer, send `notify-push` to relay |
| `packages/shared/src/types.ts` | **MODIFY** — Add push-related message types |

---

### Task 1: Generate VAPID keys and add to env

**Files:**
- Create: `apps/relay/.env.example`
- Create: `apps/pwa/.env.example`

- [ ] **Step 1: Generate VAPID key pair**

```bash
npx web-push generate-vapid-keys --json
```

Save output. Example:
```json
{
  "publicKey": "BNx...",
  "privateKey": "abc..."
}
```

- [ ] **Step 2: Create relay .env.example**

```bash
# apps/relay/.env.example
VAPID_PUBLIC_KEY=BNx...
VAPID_PRIVATE_KEY=abc...
VAPID_SUBJECT=mailto:admin@quicksave.dev
```

- [ ] **Step 3: Create PWA .env.example**

```bash
# apps/pwa/.env.example
VITE_VAPID_PUBLIC_KEY=BNx...
```

- [ ] **Step 4: Set actual env vars for dev**

For local dev, create `.env` files (gitignored) with real keys.

---

### Task 2: Push subscription store on relay

**Files:**
- Create: `apps/relay/src/pushStore.ts`

- [ ] **Step 1: Create PushStore**

```typescript
// apps/relay/src/pushStore.ts

export interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * In-memory store for push subscriptions.
 * Keyed by agentId → Set of subscriptions (one per PWA device).
 * When the relay restarts, subscriptions are lost — PWAs re-subscribe on reconnect.
 */
export class PushStore {
  private subscriptions = new Map<string, Map<string, PushSubscriptionData>>();

  /** Register a push subscription for a PWA watching an agent. */
  subscribe(agentId: string, pwaAddress: string, subscription: PushSubscriptionData): void {
    let agentSubs = this.subscriptions.get(agentId);
    if (!agentSubs) {
      agentSubs = new Map();
      this.subscriptions.set(agentId, agentSubs);
    }
    agentSubs.set(pwaAddress, subscription);
  }

  /** Remove a push subscription. */
  unsubscribe(agentId: string, pwaAddress: string): void {
    const agentSubs = this.subscriptions.get(agentId);
    if (agentSubs) {
      agentSubs.delete(pwaAddress);
      if (agentSubs.size === 0) this.subscriptions.delete(agentId);
    }
  }

  /** Get all push subscriptions for an agent. */
  getSubscriptions(agentId: string): PushSubscriptionData[] {
    const agentSubs = this.subscriptions.get(agentId);
    return agentSubs ? Array.from(agentSubs.values()) : [];
  }

  /** Remove a subscription by endpoint (called when push delivery fails with 410 Gone). */
  removeByEndpoint(endpoint: string): void {
    for (const [, agentSubs] of this.subscriptions) {
      for (const [addr, sub] of agentSubs) {
        if (sub.endpoint === endpoint) {
          agentSubs.delete(addr);
        }
      }
    }
  }

  get stats(): { totalAgents: number; totalSubscriptions: number } {
    let total = 0;
    for (const subs of this.subscriptions.values()) total += subs.size;
    return { totalAgents: this.subscriptions.size, totalSubscriptions: total };
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd apps/relay && npx tsc --noEmit`

---

### Task 3: Push service on relay

**Files:**
- Create: `apps/relay/src/pushService.ts`
- Modify: `apps/relay/package.json` (add `web-push` dependency)

- [ ] **Step 1: Install web-push**

```bash
cd /Users/jimmy/workspace/quicksave && pnpm add web-push --filter quicksave-relay
pnpm add -D @types/web-push --filter quicksave-relay
```

- [ ] **Step 2: Create PushService**

```typescript
// apps/relay/src/pushService.ts
import webpush from 'web-push';
import type { PushStore, PushSubscriptionData } from './pushStore.js';

export interface PushPayload {
  type: 'permission_request' | 'session_complete';
  agentId: string;
  sessionId?: string;
  timestamp: number;
}

export class PushService {
  private store: PushStore;

  constructor(store: PushStore) {
    this.store = store;

    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || 'mailto:admin@quicksave.dev';

    if (publicKey && privateKey) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      console.log('[push] VAPID configured');
    } else {
      console.warn('[push] VAPID keys not set — push notifications disabled');
    }
  }

  get enabled(): boolean {
    return !!process.env.VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY;
  }

  /** Send push notification to all subscribed PWAs for an agent. */
  async notifyAgent(agentId: string, payload: PushPayload): Promise<void> {
    if (!this.enabled) return;
    const subscriptions = this.store.getSubscriptions(agentId);
    if (subscriptions.length === 0) return;

    const body = JSON.stringify(payload);

    const results = await Promise.allSettled(
      subscriptions.map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
          { TTL: 300 }, // 5 min TTL
        )
      )
    );

    // Clean up expired subscriptions (410 Gone)
    for (const result of results) {
      if (result.status === 'rejected') {
        const err = result.reason;
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          const sub = subscriptions[results.indexOf(result)];
          if (sub) this.store.removeByEndpoint(sub.endpoint);
        }
      }
    }
  }
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd apps/relay && npx tsc --noEmit`

---

### Task 4: Wire push into relay server

**Files:**
- Modify: `apps/relay/src/index.ts`

- [ ] **Step 1: Import and instantiate PushStore + PushService**

Add at top of `index.ts`, after SyncStore:

```typescript
import { PushStore } from './pushStore.js';
import { PushService } from './pushService.js';

const pushStore = new PushStore();
const pushService = new PushService(pushStore);
```

- [ ] **Step 2: Handle push:subscribe and push:unsubscribe in onMessage hook**

Add to the `onMessage` hook, after the `watch-agent` handler:

```typescript
// Handle push subscription from PWA
if (m.type === 'push:subscribe' && peer.channel === 'pwa' && typeof m.agentId === 'string' && m.subscription) {
  const sub = m.subscription as { endpoint: string; keys: { p256dh: string; auth: string } };
  pushStore.subscribe(m.agentId as string, peer.address, sub);
  console.log(`[push] subscribe pwa=${peer.address.slice(0, 12)} agent=${m.agentId}`);
  sendMessage(peer.ws, { type: 'push:subscribe:ack', ok: true });
  return true;
}

if (m.type === 'push:unsubscribe' && peer.channel === 'pwa' && typeof m.agentId === 'string') {
  pushStore.unsubscribe(m.agentId as string, peer.address);
  return true;
}

// Handle push notification trigger from agent
if (m.type === 'notify-push' && peer.channel === 'agent') {
  const payload = m.payload as any;
  pushService.notifyAgent(peer.id, {
    type: payload?.type || 'permission_request',
    agentId: peer.id,
    sessionId: payload?.sessionId,
    timestamp: Date.now(),
  }).catch((err) => console.error('[push] notify error:', err));
  return true;
}
```

- [ ] **Step 3: Add pushStore stats to /stats endpoint**

Update the `onHttpRequest` `/stats` handler:

```typescript
res.end(JSON.stringify({ ...stats, syncStore: syncStore.stats, pushStore: pushStore.stats }));
```

- [ ] **Step 4: Clean up push subscriptions on PWA disconnect**

Add to the `onPeerDisconnect` hook for PWA channel, inside the watchers cleanup loop:

```typescript
// Also remove push subscriptions for this PWA
// (PWA will re-subscribe on reconnect with fresh subscription)
pushStore.unsubscribe(agentId, peer.address);
```

- [ ] **Step 5: Verify compilation and tests**

Run: `cd apps/relay && npx tsc --noEmit && npx vitest run`

---

### Task 5: Custom service worker for PWA

`vite-plugin-pwa` supports injecting custom SW code via `injectManifest` strategy. This lets us add `push` and `notificationclick` handlers alongside the existing Workbox precaching.

**Files:**
- Create: `apps/pwa/src/sw.ts`
- Modify: `apps/pwa/vite.config.ts`

- [ ] **Step 1: Create custom service worker**

```typescript
// apps/pwa/src/sw.ts
/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

// Workbox precaching (injected by vite-plugin-pwa at build time)
precacheAndRoute(self.__WB_MANIFEST);

// ── Push Notification Handler ──

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload: { type: string; agentId?: string; sessionId?: string };
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  const title = payload.type === 'permission_request'
    ? 'Claude needs your approval'
    : 'Session update';

  const options: NotificationOptions = {
    body: payload.type === 'permission_request'
      ? 'Tap to review the permission request'
      : 'Your coding session has an update',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: `quicksave-${payload.type}-${payload.sessionId ?? 'general'}`,
    data: {
      url: payload.sessionId && payload.agentId
        ? `/?agent=${payload.agentId}&session=${payload.sessionId}`
        : '/',
    },
    // iOS requires these for proper display
    requireInteraction: payload.type === 'permission_request',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification Click Handler ──

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = (event.notification.data as any)?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing window if available
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Open new window
      return self.clients.openWindow(url);
    })
  );
});
```

- [ ] **Step 2: Update vite.config.ts to use injectManifest**

Replace the `VitePWA` config:

```typescript
VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  registerType: 'autoUpdate',
  injectRegister: 'auto',
  includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
  manifest: {
    name: 'Quicksave',
    short_name: 'Quicksave',
    description: 'Remote git control with E2E encryption',
    theme_color: '#0f172a',
    background_color: '#0f172a',
    display: 'standalone',
    orientation: 'portrait',
    icons: [
      { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
      { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  },
  injectManifest: {
    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
  },
}),
```

Note: `injectManifest` compiles `src/sw.ts` and replaces `self.__WB_MANIFEST` with the precache manifest. Runtime caching is now handled in `sw.ts` if needed (the Workbox `precacheAndRoute` handles the main use case).

- [ ] **Step 3: Install workbox-precaching dependency**

```bash
cd /Users/jimmy/workspace/quicksave && pnpm add workbox-precaching --filter quicksave-pwa
```

- [ ] **Step 4: Verify PWA builds**

Run: `cd apps/pwa && npx vite build`

---

### Task 6: Push subscription management in PWA

**Files:**
- Create: `apps/pwa/src/lib/pushSubscription.ts`

- [ ] **Step 1: Create push subscription helper**

```typescript
// apps/pwa/src/lib/pushSubscription.ts

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string;

/** Convert base64 VAPID key to Uint8Array for subscribe() */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  return Notification.requestPermission();
}

export function getNotificationPermission(): NotificationPermission {
  if (!('Notification' in window)) return 'denied';
  return Notification.permission;
}

export async function subscribeToPush(): Promise<PushSubscription | null> {
  if (!VAPID_PUBLIC_KEY) {
    console.warn('[push] VAPID public key not configured');
    return null;
  }

  const registration = await navigator.serviceWorker.ready;

  // Check for existing subscription
  let subscription = await registration.pushManager.getSubscription();
  if (subscription) return subscription;

  // Create new subscription
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    return subscription;
  } catch (err) {
    console.error('[push] subscribe failed:', err);
    return null;
  }
}

export function pushSubscriptionToJSON(sub: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const json = sub.toJSON();
  return {
    endpoint: json.endpoint!,
    keys: {
      p256dh: json.keys!.p256dh!,
      auth: json.keys!.auth!,
    },
  };
}
```

- [ ] **Step 2: Verify types**

Run: `cd apps/pwa && npx tsc --noEmit`

---

### Task 7: Send push subscription to relay on connect

**Files:**
- Modify: `apps/pwa/src/lib/websocket.ts` or the connection setup code

The PWA should send `push:subscribe` to the relay after connecting and watching an agent, if notification permission is granted and a push subscription exists.

- [ ] **Step 1: Add push subscription send after watch-agent**

Find where `watch-agent` is sent to the relay (in the WebSocket connection code). After that, add:

```typescript
import { getNotificationPermission, subscribeToPush, pushSubscriptionToJSON } from './pushSubscription';

// After watch-agent succeeds:
if (getNotificationPermission() === 'granted') {
  const pushSub = await subscribeToPush();
  if (pushSub) {
    this.send({ type: 'push:subscribe', agentId, subscription: pushSubscriptionToJSON(pushSub) });
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd apps/pwa && npx tsc --noEmit`

---

### Task 8: Trigger push from agent when no PWA is connected

**Files:**
- Modify: `apps/agent/src/service/run.ts`

- [ ] **Step 1: Send notify-push when user-input-request has no connected peer**

Update the `user-input-request` handler in `run.ts`:

```typescript
claudeService.on('user-input-request', (request) => {
  const msg = createMessage('claude:user-input-request', request);
  const sent = connection.sendToSession(request.sessionId, msg);
  if (sent === 0) {
    // No PWA peer is connected — send push notification via relay
    connection.sendToRelay({
      type: 'notify-push',
      payload: {
        type: 'permission_request',
        sessionId: request.sessionId,
      },
    });
  }
});
```

Note: `connection.sendToRelay()` may need to be added to the connection class — it sends a message to the relay server itself (not to a peer). Alternatively, the agent can send it as a regular WebSocket message that the relay's `onMessage` hook picks up.

- [ ] **Step 2: Verify compilation**

Run: `cd apps/agent && npx tsc --noEmit`

---

### Task 9: Notification permission UI

**Files:**
- Create: `apps/pwa/src/components/NotificationPrompt.tsx`

- [ ] **Step 1: Create NotificationPrompt component**

A small banner that shows when notifications aren't enabled yet. Appears in the coding session view.

```typescript
// apps/pwa/src/components/NotificationPrompt.tsx
import { useState, useEffect } from 'react';
import { getNotificationPermission, requestNotificationPermission, subscribeToPush } from '../lib/pushSubscription';

export function NotificationPrompt({ onSubscribed }: { onSubscribed?: (sub: PushSubscription) => void }) {
  const [permission, setPermission] = useState(getNotificationPermission());
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('qs-notif-dismissed');
    if (stored) setDismissed(true);
  }, []);

  if (permission === 'granted' || permission === 'denied' || dismissed) return null;
  if (!('Notification' in window)) return null;

  const handleEnable = async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === 'granted') {
      const sub = await subscribeToPush();
      if (sub) onSubscribed?.(sub);
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem('qs-notif-dismissed', '1');
  };

  return (
    <div className="mx-4 mb-3 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg flex items-center gap-3">
      <div className="flex-1">
        <p className="text-sm text-blue-300">Enable notifications to get alerted when Claude needs your approval</p>
      </div>
      <button onClick={handleEnable} className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 rounded-md text-white transition-colors">
        Enable
      </button>
      <button onClick={handleDismiss} className="p-1 text-slate-500 hover:text-slate-400">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Add NotificationPrompt to ClaudePanel**

Add it above the message input area in ClaudePanel, shown once per session view.

---

## Execution Order

1. Task 1 — VAPID keys (manual, prerequisite)
2. Task 2 — PushStore (relay, no deps)
3. Task 3 — PushService (relay, depends on 2)
4. Task 4 — Wire relay (depends on 2, 3)
5. Task 5 — Custom SW (PWA, independent)
6. Task 6 — Push subscription lib (PWA, independent)
7. Task 7 — Send subscription on connect (PWA, depends on 6)
8. Task 8 — Agent trigger (agent, depends on 4)
9. Task 9 — Permission UI (PWA, depends on 6)

Tasks 2-4 (relay) and 5-6 (PWA) can be done in parallel.

## Testing

- **Local dev**: Use `vite-plugin-relay` (already spawns relay in dev). Set VAPID env vars in `.env` files.
- **Push test**: Chrome DevTools → Application → Service Workers → Push. Enter test payload JSON.
- **iOS**: Must add to home screen first. Test on real device — push simulators don't work for web push.

## Known Limitations

1. **Relay restart loses subscriptions** — PWAs re-subscribe on reconnect, so this self-heals within minutes.
2. **iOS background** — iOS may delay notifications in low-power mode. No workaround.
3. **Payload is minimal** — only type + sessionId. No tool name or details (privacy). PWA shows generic "needs approval" text.
