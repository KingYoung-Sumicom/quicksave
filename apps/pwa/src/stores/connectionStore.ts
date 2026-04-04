import { create } from 'zustand';
import type { ConnectionState, Repository, CodingPath } from '@sumicom/quicksave-shared';

export type ConnectionStep = 'signaling' | 'waiting-for-agent' | 'key-exchange' | 'handshake';

interface ConnectionStore {
  // State
  state: ConnectionState;
  agentId: string | null;
  signalingServer: string;
  repoPath: string | null;
  pendingRepoPath: string | null; // Repo to switch to after connecting
  availableRepos: Repository[];
  availableCodingPaths: CodingPath[];
  connectedAt: number | null;
  error: string | null;
  isPro: boolean;
  reconnectAttempt: number | null;
  maxReconnectAttempts: number | null;
  connectionStep: ConnectionStep | null;
  keyExchangeAttempt: number | null;
  agentOnline: boolean | null;

  // Actions
  setConnecting: (agentId: string) => void;
  setSignaling: () => void;
  setConnected: (repoPath: string, isPro: boolean, availableRepos?: Repository[], availableCodingPaths?: CodingPath[]) => void;
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

export const useConnectionStore = create<ConnectionStore>((set) => ({
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
  reconnectAttempt: null,
  maxReconnectAttempts: null,
  connectionStep: null,
  keyExchangeAttempt: null,
  agentOnline: null,

  // Actions
  setConnecting: (agentId) =>
    set({
      state: 'connecting',
      agentId,
      error: null,
    }),

  // Note: 'signaling' state was removed - this now just keeps state as 'connecting'
  setSignaling: () =>
    set({
      state: 'connecting',
    }),

  setConnected: (repoPath, isPro, availableRepos, availableCodingPaths) =>
    set({
      state: 'connected',
      repoPath: repoPath || null,
      availableRepos: availableRepos || [],
      availableCodingPaths: availableCodingPaths || [],
      connectedAt: Date.now(),
      isPro,
      error: null,
      connectionStep: null,
      keyExchangeAttempt: null,
    }),

  setRepoPath: (repoPath) =>
    set({
      repoPath,
    }),

  setPendingRepoPath: (repoPath) =>
    set({
      pendingRepoPath: repoPath,
    }),

  setAvailableRepos: (repos) =>
    set({
      availableRepos: repos,
    }),

  setAvailableCodingPaths: (paths) =>
    set({
      availableCodingPaths: paths,
    }),

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
    set({
      signalingServer: server,
    }),

  setConnectionStep: (step, attempt) =>
    set({
      connectionStep: step,
      ...(attempt !== undefined ? { keyExchangeAttempt: attempt } : {}),
    }),

  setAgentOnline: (online) =>
    set({
      agentOnline: online,
    }),

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
      reconnectAttempt: null,
      maxReconnectAttempts: null,
      connectionStep: null,
      keyExchangeAttempt: null,
      agentOnline: null,
    }),
}));
