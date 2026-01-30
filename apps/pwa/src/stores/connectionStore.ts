import { create } from 'zustand';
import type { ConnectionState, Repository } from '@quicksave/shared';

interface ConnectionStore {
  // State
  state: ConnectionState;
  agentId: string | null;
  agentPublicKey: string | null;
  signalingServer: string;
  repoPath: string | null;
  pendingRepoPath: string | null; // Repo to switch to after connecting
  availableRepos: Repository[];
  connectedAt: number | null;
  error: string | null;
  isPro: boolean;
  reconnectAttempt: number | null;
  maxReconnectAttempts: number | null;

  // Actions
  setConnecting: (agentId: string, publicKey: string) => void;
  setSignaling: () => void;
  setConnected: (repoPath: string, isPro: boolean, availableRepos?: Repository[]) => void;
  setRepoPath: (repoPath: string) => void;
  setPendingRepoPath: (repoPath: string | null) => void;
  setAvailableRepos: (repos: Repository[]) => void;
  setDisconnected: () => void;
  setReconnecting: (attempt: number, maxAttempts: number) => void;
  setError: (error: string) => void;
  setSignalingServer: (server: string) => void;
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
  agentPublicKey: null,
  signalingServer: DEFAULT_SIGNALING_SERVER,
  repoPath: null,
  pendingRepoPath: null,
  availableRepos: [],
  connectedAt: null,
  error: null,
  isPro: false,
  reconnectAttempt: null,
  maxReconnectAttempts: null,

  // Actions
  setConnecting: (agentId, publicKey) =>
    set({
      state: 'connecting',
      agentId,
      agentPublicKey: publicKey,
      error: null,
    }),

  // Note: 'signaling' state was removed - this now just keeps state as 'connecting'
  setSignaling: () =>
    set({
      state: 'connecting',
    }),

  setConnected: (repoPath, isPro, availableRepos) =>
    set({
      state: 'connected',
      repoPath,
      availableRepos: availableRepos || [],
      connectedAt: Date.now(),
      isPro,
      error: null,
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

  setDisconnected: () =>
    set({
      state: 'disconnected',
      connectedAt: null,
      reconnectAttempt: null,
      maxReconnectAttempts: null,
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

  reset: () =>
    set({
      state: 'disconnected',
      agentId: null,
      agentPublicKey: null,
      repoPath: null,
      pendingRepoPath: null,
      availableRepos: [],
      connectedAt: null,
      error: null,
      isPro: false,
      reconnectAttempt: null,
      maxReconnectAttempts: null,
    }),
}));
