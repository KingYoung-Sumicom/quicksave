// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Presence marker for the session view — the "attention" bus topic.
 *
 * The agent gates push notifications on `subscriberCount(attention) === 0`.
 * Subscribing to the session's card stream isn't a strong-enough signal:
 * a backgrounded tab on another device keeps that subscription alive,
 * which would swallow the notification on whichever device the user is
 * actually holding. Only hold the attention subscription while THIS tab
 * is both visible and focused, and release it the instant that changes.
 *
 * On browsers that fire `pagehide` without `visibilitychange` (e.g. iOS
 * when returning to Home Screen) the pagehide listener acts as a backstop.
 */
import { useEffect } from 'react';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';

export interface AttentionDeps {
  isAttending: () => boolean;
  addListener: (target: 'document' | 'window', event: string, handler: () => void) => void;
  removeListener: (target: 'document' | 'window', event: string, handler: () => void) => void;
}

function browserIsAttending(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState !== 'visible') return false;
  // `hasFocus` is not in every environment (jsdom may omit it). Treat absence
  // as focused so tests/SSR don't accidentally suppress the subscription.
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
  return true;
}

function browserDeps(): AttentionDeps {
  return {
    isAttending: browserIsAttending,
    addListener: (target, event, handler) => {
      const t = target === 'document' ? document : window;
      t.addEventListener(event, handler);
    },
    removeListener: (target, event, handler) => {
      const t = target === 'document' ? document : window;
      t.removeEventListener(event, handler);
    },
  };
}

/**
 * Installs listeners on visibility/focus changes that keep a bus subscription
 * to `/sessions/:sessionId/attention` active iff the tab is currently
 * visible+focused. Returns a disposer that removes all listeners and
 * releases the subscription.
 *
 * Exported separately from the hook so it can be unit-tested without a DOM:
 * pass a custom `AttentionDeps` and drive `sync` / `detach` by invoking the
 * handlers the deps collect.
 */
export function attachSessionAttention(
  sessionId: string,
  getBus: () => MessageBusClient | null,
  deps: AttentionDeps = browserDeps(),
): () => void {
  const path = `/sessions/${sessionId}/attention`;
  let unsub: (() => void) | null = null;

  const attach = () => {
    if (unsub) return;
    const bus = getBus();
    if (!bus) return;
    unsub = bus.subscribe(path, {
      onSnapshot: () => { /* presence-only */ },
      onUpdate: () => { /* never published */ },
      onError: (err) => console.warn(`[bus] ${path} error:`, err),
    });
  };

  const detach = () => {
    if (!unsub) return;
    unsub();
    unsub = null;
  };

  const sync = () => {
    if (deps.isAttending()) attach();
    else detach();
  };

  sync();
  deps.addListener('document', 'visibilitychange', sync);
  deps.addListener('window', 'focus', sync);
  deps.addListener('window', 'blur', sync);
  // pagehide is the only reliable event on iOS Safari when the PWA is sent
  // to background via Home Screen gesture; visibilitychange can lag.
  deps.addListener('window', 'pagehide', detach);

  return () => {
    deps.removeListener('document', 'visibilitychange', sync);
    deps.removeListener('window', 'focus', sync);
    deps.removeListener('window', 'blur', sync);
    deps.removeListener('window', 'pagehide', detach);
    detach();
  };
}

export function useSessionAttention(
  sessionId: string | null | undefined,
  getBus: () => MessageBusClient | null,
): void {
  useEffect(() => {
    if (!sessionId) return;
    return attachSessionAttention(sessionId, getBus);
  }, [sessionId, getBus]);
}
