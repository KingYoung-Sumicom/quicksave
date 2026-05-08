// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Presence marker for the session view — the "attention" bus topic.
 *
 * Two roles:
 *   1. Push gate — the agent gates push notifications on
 *      `subscriberCount(attention) === 0`. Subscribing to the session's card
 *      stream isn't a strong-enough signal: a backgrounded tab on another
 *      device keeps that subscription alive, which would swallow the
 *      notification on whichever device the user is actually holding. Only
 *      hold the attention subscription while THIS tab is both visible and
 *      focused, and release it the instant that changes.
 *   2. Read receipt — when the user attends a session we fire a
 *      `session:mark-read` command so the agent stamps `lastReadAt` on the
 *      registry entry, which broadcasts to every PWA client of the user
 *      (cross-device unread sync). The hook also re-fires mark-read while
 *      attending if the session's `lastTurnEndedAt` advances mid-view.
 *
 * On browsers that fire `pagehide` without `visibilitychange` (e.g. iOS
 * when returning to Home Screen) the pagehide listener acts as a backstop.
 */
import { useEffect, useRef } from 'react';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { useClaudeStore } from '../stores/claudeStore';

export interface AttentionDeps {
  isAttending: () => boolean;
  addListener: (target: 'document' | 'window', event: string, handler: () => void) => void;
  removeListener: (target: 'document' | 'window', event: string, handler: () => void) => void;
  /** Called when the attention state flips. Defaults to a no-op so unit tests
   *  that don't care about side effects don't have to pass anything. The
   *  browser default in `useSessionAttention` wires this to the claude store +
   *  the bus so the session's `lastReadAt` is stamped server-side the moment
   *  the user is actually looking. */
  onAttendChange?: (sessionId: string, attending: boolean) => void;
}

function browserIsAttending(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState !== 'visible') return false;
  // `hasFocus` is not in every environment (jsdom may omit it). Treat absence
  // as focused so tests/SSR don't accidentally suppress the subscription.
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
  return true;
}

function browserDeps(sendMarkRead?: (sessionId: string, viewedAt: number) => void): AttentionDeps {
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
    onAttendChange: (sessionId, attending) => {
      const { setAttendedSession } = useClaudeStore.getState();
      if (attending) {
        setAttendedSession(sessionId);
        // Fire-and-forget: best-effort mark-read. The agent persists
        // `lastReadAt` and broadcasts it on /sessions/history + /sessions/active
        // so every other PWA client of this user converges on the same value.
        sendMarkRead?.(sessionId, Date.now());
      } else {
        // Only release the slot if it was ours — guards against a stale detach
        // landing after a fast nav from session A to session B.
        const current = useClaudeStore.getState().attendedSessionId;
        if (current === sessionId) setAttendedSession(null);
      }
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
  // Track the local state so onAttendChange fires only on real transitions
  // (not on every visibilitychange that doesn't cross the threshold).
  let attending = false;

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
    const next = deps.isAttending();
    if (next === attending) {
      // Even with no transition, re-run attach() so a previously-null bus
      // gets retried once available — this matches the prior contract.
      if (next) attach();
      return;
    }
    attending = next;
    if (next) attach();
    else detach();
    deps.onAttendChange?.(sessionId, next);
  };

  // Initial sync — invoke onAttendChange only if we end up attending, so the
  // store doesn't see a spurious "false → false" transition on mount.
  if (deps.isAttending()) {
    attending = true;
    attach();
    deps.onAttendChange?.(sessionId, true);
  }
  deps.addListener('document', 'visibilitychange', sync);
  deps.addListener('window', 'focus', sync);
  deps.addListener('window', 'blur', sync);
  // pagehide is the only reliable event on iOS Safari when the PWA is sent
  // to background via Home Screen gesture; visibilitychange can lag.
  const pagehide = () => {
    detach();
    if (attending) {
      attending = false;
      deps.onAttendChange?.(sessionId, false);
    }
  };
  deps.addListener('window', 'pagehide', pagehide);

  return () => {
    deps.removeListener('document', 'visibilitychange', sync);
    deps.removeListener('window', 'focus', sync);
    deps.removeListener('window', 'blur', sync);
    deps.removeListener('window', 'pagehide', pagehide);
    detach();
    if (attending) {
      attending = false;
      deps.onAttendChange?.(sessionId, false);
    }
  };
}

export interface UseSessionAttentionOptions {
  /** Forwarded to the bus on each attention attach so the agent stamps
   *  `lastReadAt` server-side. Optional — when absent, the hook still
   *  tracks attention state but skips read receipts (useful for shared
   *  contexts that haven't wired the bus yet).
   *
   *  Note: mark-read fires ONLY on attention attach (open / refocus the
   *  session page). It deliberately does NOT auto-fire when a turn ends
   *  while you're attending, so any new turn after the initial open will
   *  re-flag the session as unread on other tabs / devices. To clear it
   *  again the user blurs and re-focuses the session tab (which counts
   *  as a fresh attach). This matches the user's "send a new prompt =
   *  list goes purple again" expectation; an always-mark-read-on-turn-end
   *  flow conflates the two states. */
  markSessionRead?: (sessionId: string, cwd: string, viewedAt: number) => void;
}

export function useSessionAttention(
  sessionId: string | null | undefined,
  getBus: () => MessageBusClient | null,
  options?: UseSessionAttentionOptions,
): void {
  const markSessionRead = options?.markSessionRead;
  // Stable wrapper so `attachSessionAttention`'s default deps don't recompute
  // every render (would tear down + re-attach the listener triplet).
  const markRef = useRef(markSessionRead);
  markRef.current = markSessionRead;

  useEffect(() => {
    if (!sessionId) return;
    const send = markRef.current
      ? (id: string, viewedAt: number) => {
          // Look up cwd from the store at call time so a missing-then-arrived
          // session entry (e.g. attention attached during a reconnect) still
          // gets a successful mark-read once the registry snapshot lands.
          const session = useClaudeStore.getState().sessions[id];
          const cwd = session?.cwd;
          if (!cwd) return;
          markRef.current?.(id, cwd, viewedAt);
        }
      : undefined;
    return attachSessionAttention(sessionId, getBus, browserDepsOrUndefined(send));
  }, [sessionId, getBus]);
}

// Helper: only construct browserDeps when sendMarkRead is provided, otherwise
// fall back to the defaults so existing tests / sites without the read-receipt
// wiring keep their original behavior.
function browserDepsOrUndefined(
  sendMarkRead: ((sessionId: string, viewedAt: number) => void) | undefined,
): AttentionDeps {
  return browserDeps(sendMarkRead);
}
