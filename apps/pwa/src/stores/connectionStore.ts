// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { create } from 'zustand';
import type { ConnectionState, Repository, CodingPath, CodexModelInfo, AgentProviderInfo, AgentAudioCapabilities } from '@sumicom/quicksave-shared';

export type ConnectionStep = 'signaling' | 'waiting-for-agent' | 'key-exchange' | 'handshake';

/** The PWA's single WebSocket connection to the signaling relay.  This must
 * never be used to infer whether a particular agent is available. */
export interface RelayConnectionState {
  state: ConnectionState;
  reconnectAttempt: number | null;
  maxReconnectAttempts: number | null;
  error: string | null;
}

/** Per-agent connection state for multi-agent tracking */
export interface AgentConnectionState {
  state: ConnectionState;
  /** Progress within this agent's encrypted session setup. */
  connectionStep: ConnectionStep | null;
  keyExchangeAttempt: number | null;
  repoPath: string | null;
  availableRepos: Repository[];
  availableCodingPaths: CodingPath[];
  isPro: boolean;
  agentVersion: string | null;
  /** Account-scoped Codex catalog advertised by this machine only. */
  codexModels: CodexModelInfo[];
  devBuild: boolean;
  /** OS the agent reported in the handshake-ack. `undefined` means the agent
   *  is older than the platform-aware build; treat as "unknown — hide
   *  platform-specific UI to be safe". */
  platform?: 'linux' | 'darwin' | 'win32' | 'other';
  /** Machine-level voice capability from the handshake ack. `undefined` ⇒ the
   *  agent did not advertise voice support; the PWA hides voice UI. */
  audio?: AgentAudioCapabilities;
  connectedAt: number | null;
  error: string | null;
  /** Relay's view of whether the agent is reachable.
   *  undefined = unknown; true/false = last known. Flips to false when the
   *  relay loses the agent WebSocket even while this peer's WebRTC stays up. */
  online?: boolean;
}

interface ConnectionStore {
  // Active-agent connection state. Mirrors `agentConnections[activeAgentId]`
  // for hooks/components that don't take an agentId. Multi-agent fan-out lives
  // in `agentConnections` below.
  state: ConnectionState;
  agentId: string | null;
  signalingServer: string;
  repoPath: string | null;
  pendingRepoPath: string | null;
  availableRepos: Repository[];
  availableCodingPaths: CodingPath[];
  connectedAt: number | null;
  error: string | null;
  isPro: boolean;
  agentVersion: string | null;
  latestVersion: string | null;
  codexModels: CodexModelInfo[];
  opencodeModels: Array<{ id: string; name: string; providerId: string; providerName: string }>;
  availableProviders: AgentProviderInfo[];
  reconnectAttempt: number | null;
  maxReconnectAttempts: number | null;
  connectionStep: ConnectionStep | null;
  keyExchangeAttempt: number | null;
  agentOnline: boolean | null;

  // Relay state is intentionally separate from the active-agent mirror above.
  relay: RelayConnectionState;

  // Multi-agent connection tracking
  agentConnections: Record<string, AgentConnectionState>;

  // Active-agent actions (mirror writes; per-agent versions live below)
  setConnecting: (agentId: string) => void;
  setSignaling: () => void;
  setConnected: (repoPath: string, isPro: boolean, availableRepos?: Repository[], availableCodingPaths?: CodingPath[], agentVersion?: string, latestVersion?: string) => void;
  setAgentVersion: (version: string) => void;
  setLatestVersion: (version: string) => void;
  setCodexModels: (models: CodexModelInfo[]) => void;
  setAvailableProviders: (providers: AgentProviderInfo[]) => void;
  setRepoPath: (repoPath: string) => void;
  setPendingRepoPath: (repoPath: string | null) => void;
  setAvailableRepos: (repos: Repository[]) => void;
  setAvailableCodingPaths: (paths: CodingPath[]) => void;
  setDisconnected: () => void;
  setReconnecting: (attempt: number, maxAttempts: number) => void;
  setError: (error: string) => void;
  setSignalingServer: (server: string) => void;
  setConnectionStep: (step: ConnectionStep, attempt?: number) => void;
  setAgentOnline: (online: boolean) => void;
  reset: () => void;

  // Relay lifecycle
  setRelayConnected: () => void;
  setRelayReconnecting: (attempt: number, maxAttempts: number) => void;
  setRelayError: (error: string) => void;
  setRelayDisconnected: () => void;

  // Multi-agent actions
  setAgentConnecting: (agentId: string) => void;
  setAgentConnected: (agentId: string, repoPath: string, isPro: boolean, availableRepos?: Repository[], availableCodingPaths?: CodingPath[], agentVersion?: string, devBuild?: boolean, platform?: 'linux' | 'darwin' | 'win32' | 'other', audio?: AgentAudioCapabilities) => void;
  setAgentCodexModels: (agentId: string, models: CodexModelInfo[]) => void;
  setAgentDisconnected: (agentId: string) => void;
  setAgentError: (agentId: string, error: string) => void;
  setAgentOnlineFor: (agentId: string, online: boolean) => void;
  setAgentConnectionStep: (agentId: string, step: ConnectionStep, attempt?: number) => void;
  setAllAgentsReconnecting: () => void;
  setAllAgentsDisconnected: () => void;
  addAgentCodingPath: (agentId: string, codingPath: CodingPath) => void;
  addAgentRepo: (agentId: string, repo: Repository) => void;
  getAgentState: (agentId: string) => AgentConnectionState | undefined;
  isAgentConnected: (agentId: string) => boolean;
}

/** Return the account-specific Codex catalog for one machine. */
export function selectCodexModelsForAgent(
  state: Pick<ConnectionStore, 'agentId' | 'agentConnections' | 'codexModels'>,
  agentId?: string | null,
): CodexModelInfo[] {
  const target = agentId ?? state.agentId;
  return target ? state.agentConnections[target]?.codexModels ?? [] : state.codexModels;
}

// In dev mode, use the same host as the page (signaling is embedded in Vite dev server)
const getDefaultSignalingServer = () => {
  if (import.meta.env.QUICKSAVE_SIGNALING_URL) {
    return import.meta.env.QUICKSAVE_SIGNALING_URL;
  }
  if (import.meta.env.DEV) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }
  return 'wss://signal.quicksave.dev';
};

const DEFAULT_SIGNALING_SERVER = getDefaultSignalingServer();

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  // Initial state
  state: 'disconnected',
  agentId: null,
  signalingServer: DEFAULT_SIGNALING_SERVER,
  repoPath: null,
  pendingRepoPath: null,
  availableRepos: [],
  availableCodingPaths: [],
  connectedAt: null,
  error: null,
  isPro: false,
  agentVersion: null,
  latestVersion: null,
  codexModels: [],
  opencodeModels: [],
  availableProviders: [],
  reconnectAttempt: null,
  maxReconnectAttempts: null,
  connectionStep: null,
  keyExchangeAttempt: null,
  agentOnline: null,
  relay: {
    state: 'connecting',
    reconnectAttempt: null,
    maxReconnectAttempts: null,
    error: null,
  },
  agentConnections: {},

  // Active-agent actions
  setConnecting: (agentId) =>
    set({
      state: 'connecting',
      agentId,
      error: null,
    }),

  setSignaling: () =>
    set({
      state: 'connecting',
    }),

  setConnected: (repoPath, isPro, availableRepos, availableCodingPaths, agentVersion, latestVersion) =>
    set({
      state: 'connected',
      repoPath: repoPath || null,
      availableRepos: availableRepos || [],
      availableCodingPaths: availableCodingPaths || [],
      connectedAt: Date.now(),
      isPro,
      agentVersion: agentVersion || null,
      latestVersion: latestVersion || null,
      error: null,
      connectionStep: null,
      keyExchangeAttempt: null,
    }),

  setAgentVersion: (version) =>
    set({ agentVersion: version }),

  setLatestVersion: (version) =>
    set({ latestVersion: version }),

  setCodexModels: (models) =>
    set({ codexModels: models }),

  setAvailableProviders: (providers) => {
    const opencode = providers.find((p) => p.id === 'opencode');
    set({
      availableProviders: providers,
      ...(opencode?.models?.length ? { opencodeModels: opencode.models } : {}),
    });
  },

  setRepoPath: (repoPath) =>
    set({ repoPath }),

  setPendingRepoPath: (repoPath) =>
    set({ pendingRepoPath: repoPath }),

  setAvailableRepos: (repos) =>
    set({ availableRepos: repos }),

  setAvailableCodingPaths: (paths) =>
    set({ availableCodingPaths: paths }),

  setDisconnected: () =>
    set({
      state: 'disconnected',
      connectedAt: null,
      reconnectAttempt: null,
      maxReconnectAttempts: null,
      connectionStep: null,
      keyExchangeAttempt: null,
      agentOnline: null,
    }),

  setReconnecting: (attempt, maxAttempts) =>
    set({
      state: 'reconnecting',
      reconnectAttempt: attempt,
      maxReconnectAttempts: maxAttempts,
    }),

  setError: (error) =>
    set({
      state: 'error',
      error,
    }),

  setSignalingServer: (server) =>
    set({ signalingServer: server }),

  setConnectionStep: (step, attempt) =>
    set({
      connectionStep: step,
      ...(attempt !== undefined ? { keyExchangeAttempt: attempt } : {}),
    }),

  setAgentOnline: (online) =>
    set({ agentOnline: online }),

  setRelayConnected: () =>
    set({
      relay: {
        state: 'connected',
        reconnectAttempt: null,
        maxReconnectAttempts: null,
        error: null,
      },
    }),

  setRelayReconnecting: (attempt, maxAttempts) =>
    set({
      relay: {
        state: 'reconnecting',
        reconnectAttempt: attempt,
        maxReconnectAttempts: maxAttempts,
        error: null,
      },
    }),

  setRelayError: (error) =>
    set((state) => ({
      relay: {
        ...state.relay,
        state: 'error',
        error,
      },
    })),

  setRelayDisconnected: () =>
    set((state) => ({
      relay: {
        ...state.relay,
        state: 'disconnected',
        reconnectAttempt: null,
        maxReconnectAttempts: null,
      },
    })),

  reset: () =>
    set({
      state: 'disconnected',
      agentId: null,
      repoPath: null,
      pendingRepoPath: null,
      availableRepos: [],
      availableCodingPaths: [],
      connectedAt: null,
      error: null,
      isPro: false,
      agentVersion: null,
      latestVersion: null,
      codexModels: [],
      opencodeModels: [],
      availableProviders: [],
      reconnectAttempt: null,
      maxReconnectAttempts: null,
      connectionStep: null,
      keyExchangeAttempt: null,
      agentOnline: null,
      relay: {
        state: 'connecting',
        reconnectAttempt: null,
        maxReconnectAttempts: null,
        error: null,
      },
    }),

  // Multi-agent actions
  setAgentConnecting: (agentId) =>
    set((state) => {
      const existing = state.agentConnections[agentId];
      return {
        agentConnections: {
          ...state.agentConnections,
          [agentId]: {
            ...(existing || {
              repoPath: null,
              availableRepos: [],
              availableCodingPaths: [],
              isPro: false,
              agentVersion: null,
              codexModels: [],
              devBuild: false,
              connectedAt: null,
            }),
            state: 'connecting',
            connectionStep: 'signaling',
            keyExchangeAttempt: null,
            error: null,
          },
        },
      };
    }),

  setAgentConnected: (agentId, repoPath, isPro, availableRepos, availableCodingPaths, agentVersion, devBuild, platform, audio) =>
    set((state) => ({
      agentConnections: {
        ...state.agentConnections,
        [agentId]: {
          state: 'connected',
          connectionStep: null,
          keyExchangeAttempt: null,
          repoPath: repoPath || null,
          availableRepos: availableRepos || [],
          availableCodingPaths: availableCodingPaths || [],
          isPro,
          agentVersion: agentVersion || null,
          codexModels: state.agentConnections[agentId]?.codexModels ?? [],
          devBuild: devBuild || false,
          platform,
          audio,
          connectedAt: Date.now(),
          error: null,
        },
      },
    })),

  setAgentCodexModels: (agentId, models) =>
    set((state) => {
      const existing = state.agentConnections[agentId];
      if (!existing) return state;
      return {
        agentConnections: {
          ...state.agentConnections,
          [agentId]: { ...existing, codexModels: models },
        },
        // Preserve the legacy active-agent mirror for callers that do not
        // have an agent id. Per-session UI must use agentConnections instead.
        ...(state.agentId === agentId ? { codexModels: models } : {}),
      };
    }),

  setAgentDisconnected: (agentId) =>
    set((state) => {
      const { [agentId]: _, ...rest } = state.agentConnections;
      return { agentConnections: rest };
    }),

  setAgentError: (agentId, error) =>
    set((state) => ({
      agentConnections: {
        ...state.agentConnections,
        [agentId]: {
          ...(state.agentConnections[agentId] || {
            state: 'error', repoPath: null, availableRepos: [],
            availableCodingPaths: [], isPro: false, agentVersion: null, devBuild: false, connectedAt: null,
            codexModels: [], connectionStep: null, keyExchangeAttempt: null,
          }),
          state: 'error',
          error,
        },
      },
    })),

  setAgentOnlineFor: (agentId, online) =>
    set((state) => {
      const existing = state.agentConnections[agentId];
      if (!existing) return state;
      return {
        agentConnections: {
          ...state.agentConnections,
          [agentId]: online
            ? { ...existing, online }
            : {
              ...existing,
              // The relay is still healthy, but this peer is not. Surface it
              // only on routes that belong to this agent and wait for its
              // normal watch/key-exchange recovery path.
              state: 'reconnecting',
              connectionStep: 'waiting-for-agent',
              keyExchangeAttempt: null,
              online,
            },
        },
      };
    }),

  setAgentConnectionStep: (agentId, connectionStep, attempt) =>
    set((state) => {
      const existing = state.agentConnections[agentId];
      if (!existing) return state;
      return {
        agentConnections: {
          ...state.agentConnections,
          [agentId]: {
            ...existing,
            connectionStep,
            ...(attempt !== undefined ? { keyExchangeAttempt: attempt } : {}),
          },
        },
      };
    }),

  setAllAgentsReconnecting: () =>
    set((state) => ({
      agentConnections: Object.fromEntries(
        Object.entries(state.agentConnections).map(([agentId, connection]) => [agentId, {
          ...connection,
          state: 'reconnecting',
          connectionStep: 'signaling',
          keyExchangeAttempt: null,
        }]),
      ),
    })),

  setAllAgentsDisconnected: () =>
    set((state) => ({
      agentConnections: Object.fromEntries(
        Object.entries(state.agentConnections).map(([agentId, connection]) => [agentId, {
          ...connection,
          state: 'disconnected',
          connectionStep: null,
          keyExchangeAttempt: null,
          online: false,
        }]),
      ),
    })),

  addAgentCodingPath: (agentId, codingPath) =>
    set((state) => {
      const existing = state.agentConnections[agentId];
      if (!existing) return state;
      if (existing.availableCodingPaths.some((p) => p.path === codingPath.path)) return state;
      return {
        agentConnections: {
          ...state.agentConnections,
          [agentId]: {
            ...existing,
            availableCodingPaths: [...existing.availableCodingPaths, codingPath],
          },
        },
      };
    }),

  addAgentRepo: (agentId, repo) =>
    set((state) => {
      const existing = state.agentConnections[agentId];
      if (!existing) return state;
      if (existing.availableRepos.some((r) => r.path === repo.path)) return state;
      return {
        agentConnections: {
          ...state.agentConnections,
          [agentId]: {
            ...existing,
            availableRepos: [...existing.availableRepos, repo],
          },
        },
      };
    }),

  getAgentState: (agentId) => get().agentConnections[agentId],

  isAgentConnected: (agentId) => get().agentConnections[agentId]?.state === 'connected',
}));
