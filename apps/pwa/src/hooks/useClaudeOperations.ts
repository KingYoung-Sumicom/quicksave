// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef } from 'react';
import {
  type CardHistoryResponse,
  type ClaudeStartResponsePayload,
  type ClaudeResumeResponsePayload,
  type ClaudeInterruptResponsePayload,
  type ClaudeSteerQueuedResponsePayload,
  type ClaudeDeleteQueuedResponsePayload,
  type ClaudeCancelResponsePayload,
  type ClaudeCloseResponsePayload,
  type ClaudeEndTaskResponsePayload,
  type ClaudeGetMessagesRequestPayload,
  type ClaudeUserInputResponsePayload,
  type ClaudePreferences,
  type ClaudeSetPreferencesResponsePayload,
  type ClaudeSetSessionPermissionResponsePayload,
  type AgentId,
  type AttachmentMetadata,
  type ConfigValue,
  type SessionCardsUpdate,
  type SessionSetConfigResponsePayload,
  type SessionControlRequestPayload,
  type SessionControlRequestResponsePayload,
  type SessionListSlashCommandsRequestPayload,
  type SessionListSlashCommandsResponsePayload,
  type SessionUpdateHistoryResponsePayload,
  type SessionListArchivedRequestPayload,
  type SessionListArchivedResponsePayload,
  type SessionMarkReadRequestPayload,
  type SessionMarkReadResponsePayload,
  type SessionDismissPendingMissionRequestPayload,
  type SessionDismissPendingMissionResponsePayload,
  type ProjectListSummariesResponsePayload,
  type ProjectListReposResponsePayload,
  type ProjectDeleteRequestPayload,
  type ProjectDeleteResponsePayload,
  type SessionQueueState,
} from '@sumicom/quicksave-shared';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { useClaudeStore } from '../stores/claudeStore';
import { useConnectionStore } from '../stores/connectionStore';
import { applySessionCardsSnapshot, applySessionCardsUpdate } from '../lib/applySessionCards';
import { primeUploadedAttachment } from '../lib/attachmentUploader';
import { getCodexFastServiceTierId } from '../lib/claudePresets';

const QUEUE_PREVIEW_MAX = 80;
const OPTIMISTIC_QUEUE_MIN_MS = 1500;

function queuedPromptPreview(prompt: string): string | undefined {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > QUEUE_PREVIEW_MAX
    ? `${compact.slice(0, QUEUE_PREVIEW_MAX - 3)}...`
    : compact;
}

function appendOptimisticQueueState(
  current: SessionQueueState | null | undefined,
  prompt: string,
  optimisticUntil: number,
): SessionQueueState {
  const preview = queuedPromptPreview(prompt);
  const existingPreviews = current?.queuedPromptPreviews
    ?? (current?.latestPromptPreview ? [current.latestPromptPreview] : []);
  const queuedPromptPreviews = preview
    ? [...existingPreviews, preview]
    : existingPreviews;
  return {
    pendingUserMessages: (current?.pendingUserMessages ?? existingPreviews.length) + 1,
    latestPromptPreview: preview ?? current?.latestPromptPreview,
    ...(queuedPromptPreviews.length > 0 ? { queuedPromptPreviews } : {}),
    canInterruptCurrentTurn: true,
    optimisticUntil,
  };
}

export function shouldAdoptResumeResult(opts: {
  requestedSessionId: string;
  actualSessionId: string;
  activeSessionIdAtRequest: string | null;
  currentActiveSessionId: string | null;
}): boolean {
  if (opts.currentActiveSessionId === opts.requestedSessionId) return true;
  if (opts.currentActiveSessionId === opts.actualSessionId) return true;
  return opts.activeSessionIdAtRequest === null && opts.currentActiveSessionId === null;
}

export function useClaudeOperations(
  getBus: () => MessageBusClient | null,
) {
  // Per-session unsubscribe fns for /sessions/:id/cards bus subscriptions.
  const cardsUnsubsRef = useRef<Map<string, () => void>>(new Map());
  const cardsSnapshotBuffersRef = useRef<Map<string, SessionCardsUpdate[]>>(new Map());

  // Release every live /sessions/:id/cards subscription when the hook
  // unmounts. Without this, navigating away from a ProjectDetail leaks the
  // wire-level subscription (the Map dies with the hook but the bus-side
  // refcount never decrements), and a subsequent visit to a different
  // session lands on a panel whose snapshot was dropped because the bus
  // believes a stale subscriber still owns the path.
  useEffect(() => {
    const unsubs = cardsUnsubsRef.current;
    return () => {
      for (const unsub of unsubs.values()) {
        try { unsub(); } catch { /* swallow */ }
      }
      unsubs.clear();
      cardsSnapshotBuffersRef.current.clear();
    };
  }, []);
  const {
    upsertSession,
    setActiveSession,
    setStreaming,
    setStreamError,
    prependCards,
    appendCard,
    setHistoryMeta,
    setLoadingHistory,
    setHistoryError,
    clearCards,
    setSelectedPermissionMode,
    setAgentPref,
    setSessionConfigKey,
    applySessionConfig,
  } = useClaudeStore();

  // Apply server-pushed preferences. ClaudePreferences is wire-scoped to the
  // claude-code agent (the daemon doesn't know about codex prefs), so write
  // directly into that bucket — using the active-agent setters would clobber
  // the user's codex prefs whenever they're viewing Codex during a reconnect.
  const applyPreferences = useCallback((prefs: Partial<ClaudePreferences>) => {
    if (prefs.model !== undefined) setAgentPref('claude-code', 'model', prefs.model);
    if (prefs.reasoningEffort !== undefined) setAgentPref('claude-code', 'reasoningEffort', prefs.reasoningEffort);
  }, [setAgentPref]);

  /**
   * Issue a one-shot bus command. Rejects if the bus isn't ready, on timeout,
   * or on a server-side error (encoded as "CODE: message" by the agent's bus
   * adapter so callers can parse specific structured error codes).
   */
  const sendCommand = useCallback(
    <R, P = unknown>(verb: string, payload: P, timeoutMs = 30000): Promise<R> => {
      const bus = getBus();
      if (!bus) return Promise.reject(new Error('Not connected'));
      return bus.command<R, P>(verb, payload, { timeoutMs, queueWhileDisconnected: true });
    },
    [getBus],
  );

  /**
   * For offset === 0 (initial load / resubscribe after navigation): opens a
   * `/sessions/:id/cards` bus subscription. The snapshot populates cards +
   * title; subsequent updates stream live CardEvents and CardStreamEnd into
   * the store. Duplicate calls for the same session are no-ops (the bus
   * client dedups wire frames and the per-session unsub handle is preserved).
   *
   * For offset > 0 (pagination): issues the `claude:get-cards` command and
   * prepends the returned page to the store. `offset` remains a legacy-server
   * fallback; current agents receive the opaque cursor saved from the prior
   * response so rendered/live card counts cannot shift the history boundary.
   */
  const getSessionCards = useCallback(
    async (sessionId: string, offset = 0, limit = 50, cwd?: string, subscribeOnly = false) => {
      if (offset === 0) {
        const bus = getBus();
        if (!bus) return;
        if (cardsSnapshotBuffersRef.current.has(sessionId)) return;
        // Release any stale subscription for this session before re-subscribing.
        // ClaudePanel only unsubs through its nav effect / handleNewSession,
        // so the ProjectList "+" button (which navigates straight to /add)
        // and direct URL bar navigation leave the previous session's entry
        // in cardsUnsubsRef. After the user creates a new session and comes
        // back, ClaudePanel.tsx clearCards() wipes the store, calls us, and
        // a plain dedup early-return would leave the panel blank — the bus
        // client's lastSnapshot cache only replays on a NEW subscribe call.
        // Releasing first triggers an unsub→sub on the wire so the agent
        // re-emits a fresh snapshot.
        const existing = cardsUnsubsRef.current.get(sessionId);
        if (existing) {
          cardsUnsubsRef.current.delete(sessionId);
          existing();
        }
        if (!subscribeOnly) {
          setLoadingHistory(true);
          setHistoryError(null);
        }
        cardsSnapshotBuffersRef.current.set(sessionId, []);
        try {
          const unsub = bus.subscribe<CardHistoryResponse, SessionCardsUpdate>(
            `/sessions/${sessionId}/cards`,
            {
              onSnapshot: (snap) => {
                const bufferedUpdates = cardsSnapshotBuffersRef.current.get(sessionId) ?? [];
                cardsSnapshotBuffersRef.current.delete(sessionId);
                if (!subscribeOnly) setLoadingHistory(false);
                applySessionCardsSnapshot(sessionId, snap);
                for (const update of bufferedUpdates) {
                  applySessionCardsUpdate(sessionId, update);
                }
              },
              onUpdate: (update) => {
                const buffer = cardsSnapshotBuffersRef.current.get(sessionId);
                if (buffer) {
                  buffer.push(update);
                  return;
                }
                applySessionCardsUpdate(sessionId, update);
              },
              onError: (err) => {
                cardsSnapshotBuffersRef.current.delete(sessionId);
                console.warn(`[bus] /sessions/${sessionId}/cards error:`, err);
                if (!subscribeOnly) {
                  setHistoryError(err);
                  setLoadingHistory(false);
                }
              },
              acceptStaleSnapshots: true,
            },
          );
          cardsUnsubsRef.current.set(sessionId, unsub);
        } catch (err) {
          cardsSnapshotBuffersRef.current.delete(sessionId);
          throw err;
        }
        return;
      }

      // Pagination: fetch older history via command.
      setLoadingHistory(true);
      setHistoryError(null);
      try {
        const cursor = useClaudeStore.getState().historyCursor;
        const response = await sendCommand<CardHistoryResponse, ClaudeGetMessagesRequestPayload>(
          'claude:get-cards',
          { sessionId, offset, limit, ...(cursor ? { cursor } : {}), ...(cwd ? { cwd } : {}) },
        );
        if (response.error) throw new Error(response.error);
        prependCards(response.cards);
        setHistoryMeta(response.total, response.hasMore, response.nextCursor);
      } catch (error) {
        console.error('Failed to get session cards:', error);
        setHistoryError(error instanceof Error ? error.message : 'Failed to load history');
      } finally {
        setLoadingHistory(false);
      }
    },
    [getBus, sendCommand, prependCards, setHistoryMeta, setLoadingHistory, setHistoryError]
  );

  const startSession = useCallback(
    async (prompt: string, opts?: { agent?: AgentId; allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string; cwd?: string; sandboxed?: boolean; reasoningEffort?: string; fastMode?: boolean; contextWindow?: number; attachmentIds?: string[]; attachmentMetadata?: AttachmentMetadata[] }) => {
      clearCards();
      setStreaming(true);
      setStreamError(null);
      const fastServiceTier = opts?.fastMode
        ? getCodexFastServiceTierId(
          useConnectionStore.getState().codexModels.find((model) => model.id === opts.model),
        ) ?? 'fast'
        : undefined;
      const hasOptimisticUserCard = prompt.trim().length > 0
        || (opts?.attachmentMetadata?.length ?? 0) > 0;
      if (hasOptimisticUserCard) {
        // Add user card immediately (optimistic). Attachments carry metadata
        // only — the local upload manager still has the bytes; we'll prime the
        // attachment cache with them once the agent assigns a sessionId.
        appendCard({
          type: 'user',
          id: `local-user-${Date.now()}`,
          timestamp: Date.now(),
          text: prompt,
          ...(opts?.attachmentMetadata && opts.attachmentMetadata.length > 0
            ? { attachments: opts.attachmentMetadata }
            : {}),
        });
      }
      try {
        console.log(`[sub] start → implicit subscribe (new session)`);
        const response = await sendCommand<ClaudeStartResponsePayload>(
          'claude:start',
          {
            prompt,
            agent: opts?.agent,
            allowedTools: opts?.allowedTools,
            systemPrompt: opts?.systemPrompt,
            model: opts?.model,
            permissionMode: opts?.permissionMode,
            sandboxed: opts?.sandboxed,
            reasoningEffort: opts?.reasoningEffort,
            ...(fastServiceTier ? { serviceTier: fastServiceTier } : {}),
            // contextWindow drives CLAUDE_CODE_AUTO_COMPACT_WINDOW on the
            // spawned CLI; without it the model defaults to its full window
            // (1M for opus-4-8) and auto-compact never fires at the user's pick.
            ...(opts?.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
            ...(opts?.cwd ? { cwd: opts.cwd } : {}),
            ...(opts?.attachmentIds && opts.attachmentIds.length > 0
              ? { attachmentIds: opts.attachmentIds }
              : {}),
          },
          120000,
        );
        if (!response.success) {
          throw new Error(response.error || 'Failed to start session');
        }
        // Pre-populate session state so the indicator flips to "thinking"
        // immediately, without waiting for the async session-updated broadcast.
        // Missing the broadcast (e.g. transient subscribe races) would otherwise
        // leave the indicator stuck on "closed".
        if (response.sessionId) {
          upsertSession({
            sessionId: response.sessionId,
            isActive: true,
            isStreaming: true,
            hasPendingInput: false,
            ...(opts?.agent ? { agent: opts.agent } : {}),
            ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}),
            ...(opts?.cwd ? { cwd: opts.cwd } : {}),
          });
          // Push the local upload bytes into the attachment cache so this
          // tab never re-fetches what it just uploaded.
          if (opts?.attachmentIds) {
            for (const id of opts.attachmentIds) {
              primeUploadedAttachment(response.sessionId, id);
            }
          }
        }
        setActiveSession(response.sessionId ?? null);
        // ClaudePanel's urlSessionId effect subscribes via the per-route
        // useClaudeOperations instance once it mounts at the new URL. We
        // intentionally do NOT subscribe here: doing so would register the
        // unsub handle in the top-level hook's `cardsUnsubsRef`, while every
        // later unsubscribe/release-first call runs through the per-route
        // hook's separate Map. The mismatch would leave a stale wire
        // subscription whose cached `lastSnapshot` is the just-started
        // session's empty-or-near-empty initial snapshot — replaying it to a
        // late-joining subscriber permanently strands the chat on the first
        // message until reload.
      } catch (error) {
        setStreaming(false);
        setStreamError(error instanceof Error ? error.message : 'Failed to start session');
        return false;
      }
      return true;
    },
    [sendCommand, clearCards, setStreaming, setStreamError, setActiveSession, appendCard, upsertSession]
  );

  const resumeSession = useCallback(
    async (sessionId: string, prompt: string, cwd?: string, opts?: { attachmentIds?: string[]; attachmentMetadata?: AttachmentMetadata[]; interruptCurrentTurn?: boolean }) => {
      const state = useClaudeStore.getState();
      const session = state.sessions[sessionId];
      const activeSessionIdAtRequest = state.activeSessionId;
      const wasAlreadyStreaming = state.isStreaming || session?.isStreaming === true;
      const queueInsteadOfAppend = wasAlreadyStreaming && !opts?.interruptCurrentTurn;
      setStreaming(true);
      setStreamError(null);
      if (queueInsteadOfAppend) {
        const optimisticUntil = Date.now() + OPTIMISTIC_QUEUE_MIN_MS;
        upsertSession({
          sessionId,
          isActive: true,
          isStreaming: true,
          queueState: appendOptimisticQueueState(session?.queueState, prompt, optimisticUntil),
        });
        window.setTimeout(() => {
          const latest = useClaudeStore.getState().sessions[sessionId]?.queueState;
          if (latest?.optimisticUntil === optimisticUntil) {
            upsertSession({ sessionId, queueState: null });
          }
        }, OPTIMISTIC_QUEUE_MIN_MS);
      }
      // Prime the attachment cache BEFORE appending the optimistic card so
      // the chip's first render reads bytes from L1 instead of firing
      // `attachment:fetch` against the agent's disk store, which may not
      // have persisted the bytes yet (the agent only writes after `claude:
      // resume` returns the sessionId). Primed under the requested
      // sessionId; we re-prime under the actual id below in case of a cold
      // resume that forks the id.
      if (opts?.attachmentIds) {
        for (const id of opts.attachmentIds) {
          primeUploadedAttachment(sessionId, id);
        }
      }
      if (!queueInsteadOfAppend) {
        appendCard({
          type: 'user',
          id: `local-user-${Date.now()}`,
          timestamp: Date.now(),
          text: prompt,
          ...(opts?.attachmentMetadata && opts.attachmentMetadata.length > 0
            ? { attachments: opts.attachmentMetadata }
            : {}),
        });
      }
      try {
        console.log(`[sub] resume → implicit subscribe session=${sessionId.slice(0, 8)}`);
        const response = await sendCommand<ClaudeResumeResponsePayload>(
          'claude:resume',
          {
            sessionId,
            prompt,
            ...(cwd ? { cwd } : {}),
            ...(opts?.interruptCurrentTurn ? { interruptCurrentTurn: true } : {}),
            ...(opts?.attachmentIds && opts.attachmentIds.length > 0
              ? { attachmentIds: opts.attachmentIds }
              : {}),
          },
          120000,
        );
        if (!response.success) {
          throw new Error(response.error || 'Failed to resume session');
        }
        const actualSessionId = response.sessionId ?? sessionId;
        // Flip the indicator to "thinking" immediately so we don't rely on the
        // session-updated broadcast being delivered before the user looks at
        // the session list.
        upsertSession({
          sessionId: actualSessionId,
          isActive: true,
          isStreaming: true,
          hasPendingInput: false,
          ...(response.queueState !== undefined ? { queueState: response.queueState } : {}),
        });
        // Push local upload bytes into the cache for this session so the
        // sender never has to re-fetch what it just uploaded.
        if (opts?.attachmentIds) {
          for (const id of opts.attachmentIds) {
            primeUploadedAttachment(actualSessionId, id);
          }
        }
        if (!wasAlreadyStreaming) {
          const shouldAdopt = shouldAdoptResumeResult({
            requestedSessionId: sessionId,
            actualSessionId,
            activeSessionIdAtRequest,
            currentActiveSessionId: useClaudeStore.getState().activeSessionId,
          });
          if (shouldAdopt) {
            // Cold resume: bind the active session to whatever id the daemon
            // returned. If the user navigated to another session while the
            // process was spawning, keep their current focus and only update
            // the session list state above.
            setActiveSession(actualSessionId);
            // Cold resume can fork the session_id (CLI emits a new id when
            // resuming an existing transcript). The PWA's card subscription is
            // keyed by sessionId, so bus updates for the new id would never
            // reach the store. Rebind only while this resume still owns the
            // visible session; otherwise it would steal the active card stream.
            if (actualSessionId !== sessionId) {
              const oldUnsub = cardsUnsubsRef.current.get(sessionId);
              if (oldUnsub) {
                cardsUnsubsRef.current.delete(sessionId);
                oldUnsub();
              }
              getSessionCards(actualSessionId, 0, 50, cwd, /* subscribeOnly */ true);
            }
          }
        }
      } catch (error) {
        setStreaming(false);
        setStreamError(error instanceof Error ? error.message : 'Failed to resume session');
        return false;
      }
      return true;
    },
    [sendCommand, setStreaming, setStreamError, setActiveSession, appendCard, upsertSession, getSessionCards]
  );

  const cancelSession = useCallback(
    async (sessionId: string) => {
      setStreaming(false);
      try {
        await sendCommand<ClaudeCancelResponsePayload>('claude:cancel', { sessionId });
      } catch (error) {
        console.error('Failed to cancel session:', error);
      }
    },
    [sendCommand, setStreaming]
  );

  const interruptSession = useCallback(
    async (sessionId: string) => {
      try {
        await sendCommand<ClaudeInterruptResponsePayload>('claude:interrupt', { sessionId });
      } catch (error) {
        console.error('Failed to interrupt session:', error);
      }
    },
    [sendCommand]
  );

  const steerQueuedSession = useCallback(
    async (sessionId: string, interruptCurrentTurn = true) => {
      try {
        await sendCommand<ClaudeSteerQueuedResponsePayload>(
          'claude:steer-queued',
          { sessionId, interruptCurrentTurn },
        );
      } catch (error) {
        console.error('Failed to steer queued message:', error);
      }
    },
    [sendCommand]
  );

  const deleteQueuedSession = useCallback(
    async (sessionId: string, queuedId: string) => {
      try {
        await sendCommand<ClaudeDeleteQueuedResponsePayload>(
          'claude:delete-queued',
          { sessionId, queuedId },
        );
      } catch (error) {
        console.error('Failed to delete queued message:', error);
      }
    },
    [sendCommand]
  );

  const closeSession = useCallback(
    async (sessionId: string) => {
      setStreaming(false);
      try {
        await sendCommand<ClaudeCloseResponsePayload>('claude:close', { sessionId });
      } catch (error) {
        console.error('Failed to close session:', error);
      }
    },
    [sendCommand, setStreaming]
  );

  // End the task entirely: kill the live process AND archive the registry
  // entry so the session disappears from the active list. The corresponding
  // session:history-updated broadcast will reconcile the PWA's session list.
  const endSession = useCallback(
    async (sessionId: string) => {
      setStreaming(false);
      try {
        await sendCommand<ClaudeEndTaskResponsePayload>('claude:end-task', { sessionId });
      } catch (error) {
        console.error('Failed to end session:', error);
      }
    },
    [sendCommand, setStreaming]
  );

  const restoreSession = useCallback(
    async (sessionId: string, cwd: string) => {
      try {
        await sendCommand<SessionUpdateHistoryResponsePayload>(
          'session:update-history',
          { sessionId, cwd, updates: { archived: false } },
        );
      } catch (error) {
        console.error('Failed to restore session:', error);
      }
    },
    [sendCommand],
  );

  // Stamp `lastReadAt` on a session so the email-style unread badge clears
  // for every PWA client of the same user. Best-effort — errors are logged
  // but not surfaced; the next attention attach will retry.
  const markSessionRead = useCallback(
    async (sessionId: string, cwd: string, viewedAt: number = Date.now()) => {
      try {
        await sendCommand<SessionMarkReadResponsePayload, SessionMarkReadRequestPayload>(
          'session:mark-read',
          { sessionId, cwd, viewedAt },
        );
      } catch (error) {
        console.error('Failed to mark session read:', error);
      }
    },
    [sendCommand],
  );

  const dismissPendingMission = useCallback(
    async (sessionId: string, cwd: string, dismissedAt: number = Date.now()) => {
      try {
        await sendCommand<SessionDismissPendingMissionResponsePayload, SessionDismissPendingMissionRequestPayload>(
          'session:dismiss-pending-mission',
          { sessionId, cwd, dismissedAt },
        );
      } catch (error) {
        console.error('Failed to dismiss pending mission:', error);
      }
    },
    [sendCommand],
  );

  const listArchivedSessions = useCallback(
    async (cwd: string, offset = 0, limit = 20) => {
      try {
        return await sendCommand<SessionListArchivedResponsePayload, SessionListArchivedRequestPayload>(
          'session:list-archived',
          { cwd, offset, limit },
        );
      } catch (error) {
        console.error('Failed to list archived sessions:', error);
        return null;
      }
    },
    [sendCommand],
  );

  const setPreferences = useCallback(
    (prefs: Partial<ClaudePreferences>) => {
      applyPreferences(prefs); // optimistic
      sendCommand<ClaudeSetPreferencesResponsePayload, { preferences: Partial<ClaudePreferences> }>(
        'claude:set-preferences',
        { preferences: prefs },
      ).then((response) => {
        applyPreferences(response.preferences); // confirm with actual applied value
      }).catch(() => { /* broadcast will resync if needed */ });
    },
    [sendCommand, applyPreferences],
  );

  const setSessionPermission = useCallback(
    (sessionId: string, permissionMode: string) => {
      setSelectedPermissionMode(permissionMode);
      sendCommand<ClaudeSetSessionPermissionResponsePayload, { sessionId: string; permissionMode: string }>(
        'claude:set-session-permission',
        { sessionId, permissionMode },
      ).catch(() => {});
    },
    [sendCommand, setSelectedPermissionMode],
  );

  const setSessionConfig = useCallback(
    (sessionId: string, key: string, value: ConfigValue) => {
      setSessionConfigKey(sessionId, key, value); // optimistic
      sendCommand<SessionSetConfigResponsePayload, { sessionId: string; key: string; value: ConfigValue }>(
        'session:set-config',
        { sessionId, key, value },
      ).then((response) => {
        applySessionConfig(sessionId, response.config); // confirm with actual applied config (rolled back on failure)
        if (response.success === false && response.error) {
          // The CLI rejected the change (e.g. set_permission_mode 'auto' not supported for this model/plan).
          // The agent has already rolled back its state and returned the actual current config;
          // applySessionConfig above reconciles the UI. Warn the user so they know why their change was reverted.
          window.alert(`Can't set ${key} to "${String(value)}": ${response.error}`);
        }
      }).catch(() => {});
    },
    [sendCommand, setSessionConfigKey, applySessionConfig],
  );

  const sendControlRequest = useCallback(
    async (sessionId: string, subtype: string, params?: Record<string, unknown>): Promise<SessionControlRequestResponsePayload> => {
      // Allow a long wall-time budget — server pauses its idle timer during compaction/turn work.
      return sendCommand<SessionControlRequestResponsePayload, SessionControlRequestPayload>(
        'session:control-request',
        { sessionId, subtype, params },
        10 * 60 * 1000,
      );
    },
    [sendCommand],
  );

  const listSlashCommands = useCallback(
    async (
      sessionId: string,
      opts?: { cwd?: string; forceReload?: boolean },
    ): Promise<SessionListSlashCommandsResponsePayload> => {
      return sendCommand<SessionListSlashCommandsResponsePayload, SessionListSlashCommandsRequestPayload>(
        'session:list-slash-commands',
        { sessionId, cwd: opts?.cwd, forceReload: opts?.forceReload },
        30_000,
      );
    },
    [sendCommand],
  );

  const respondToUserInput = useCallback(
    (response: ClaudeUserInputResponsePayload) => {
      sendCommand<void, ClaudeUserInputResponsePayload>(
        'claude:user-input-response',
        response,
      ).catch((err) => {
        console.warn('[respondToUserInput] failed:', err);
      });
    },
    [sendCommand]
  );

  /**
   * Release the `/sessions/:id/cards` bus subscription for this session. The
   * MessageBusClient refcounts subscriptions, so duplicate calls are safe.
   */
  const unsubscribeSession = useCallback(
    (sessionId: string) => {
      const unsub = cardsUnsubsRef.current.get(sessionId);
      if (!unsub) return;
      cardsUnsubsRef.current.delete(sessionId);
      unsub();
    },
    []
  );

  const listProjectRepos = useCallback(async (cwd: string) => {
    try {
      const response = await sendCommand<ProjectListReposResponsePayload>('project:list-repos', { cwd });
      if (response.error) {
        console.error('Failed to list project repos:', response.error);
        return null;
      }
      return response.repos;
    } catch (error) {
      console.error('Failed to list project repos:', error);
      return null;
    }
  }, [sendCommand]);

  const listProjectSummaries = useCallback(async () => {
    try {
      const response = await sendCommand<ProjectListSummariesResponsePayload>('project:list-summaries', {});
      if (response.error) {
        console.error('Failed to list project summaries:', response.error);
        return null;
      }
      return response.projects;
    } catch (error) {
      console.error('Failed to list project summaries:', error);
      return null;
    }
  }, [sendCommand]);

  const deleteProject = useCallback(
    async (cwd: string): Promise<ProjectDeleteResponsePayload | null> => {
      try {
        return await sendCommand<ProjectDeleteResponsePayload, ProjectDeleteRequestPayload>(
          'project:delete',
          { cwd },
        );
      } catch (error) {
        console.error('Failed to delete project:', error);
        return null;
      }
    },
    [sendCommand],
  );

  return {
    getSessionCards,
    startSession,
    resumeSession,
    interruptSession,
    steerQueuedSession,
    deleteQueuedSession,
    cancelSession,
    closeSession,
    endSession,
    restoreSession,
    markSessionRead,
    dismissPendingMission,
    listArchivedSessions,
    respondToUserInput,
    setPreferences,
    setSessionPermission,
    setSessionConfig,
    sendControlRequest,
    listSlashCommands,
    unsubscribeSession,
    listProjectSummaries,
    listProjectRepos,
    deleteProject,
  };
}
