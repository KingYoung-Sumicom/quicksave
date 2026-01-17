import { create } from 'zustand';
import type { ConnectionState } from '@quicksave/shared';

interface ConnectionStore {
  // State
  state: ConnectionState;
  agentId: string | null;
  agentPublicKey: string | null;
  signalingServer: string;
  repoPath: string | null;
  connectedAt: number | null;
  error: string | null;
  isPro: boolean;
  reconnectAttempt: number | null;
  maxReconnectAttempts: number | null;

  // Actions
  setConnecting: (agentId: string, publicKey: string) => void;
  setSignaling: () => void;
  setConnected: (repoPath: string, isPro: boolean) => void;
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

  setSignaling: () =>
    set({
      state: 'signaling',
    }),

  setConnected: (repoPath, isPro) =>
    set({
      state: 'connected',
      repoPath,
      connectedAt: Date.now(),
      isPro,
      error: null,
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
      connectedAt: null,
      error: null,
      isPro: false,
      reconnectAttempt: null,
      maxReconnectAttempts: null,
    }),
}));
