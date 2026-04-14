import { describe, it, expect, beforeEach } from 'vitest';
import { useConnectionStore } from './connectionStore';

describe('connectionStore', () => {
  beforeEach(() => {
    useConnectionStore.getState().reset();
  });

  describe('initial state', () => {
    it('starts disconnected with null fields', () => {
      const state = useConnectionStore.getState();
      expect(state.state).toBe('disconnected');
      expect(state.agentId).toBeNull();
      expect(state.repoPath).toBeNull();
      expect(state.error).toBeNull();
      expect(state.connectedAt).toBeNull();
      expect(state.isPro).toBe(false);
      expect(state.agentOnline).toBeNull();
    });
  });

  describe('state transitions', () => {
    it('disconnected -> connecting', () => {
      useConnectionStore.getState().setConnecting('agent-123');
      const state = useConnectionStore.getState();
      expect(state.state).toBe('connecting');
      expect(state.agentId).toBe('agent-123');
      expect(state.error).toBeNull();
    });

    it('connecting -> connected', () => {
      useConnectionStore.getState().setConnecting('agent-123');
      useConnectionStore.getState().setConnected(
        '/home/user/repo', true,
        [{ path: '/home/user/repo', name: 'repo' }],
        [{ path: '/home/user/code', name: 'code' }],
        '1.0.0', '1.1.0', false,
      );
      const state = useConnectionStore.getState();
      expect(state.state).toBe('connected');
      expect(state.repoPath).toBe('/home/user/repo');
      expect(state.isPro).toBe(true);
      expect(state.availableRepos).toHaveLength(1);
      expect(state.availableCodingPaths).toHaveLength(1);
      expect(state.agentVersion).toBe('1.0.0');
      expect(state.latestVersion).toBe('1.1.0');
      expect(state.connectedAt).toBeTypeOf('number');
      expect(state.error).toBeNull();
      expect(state.connectionStep).toBeNull();
    });

    it('connected -> disconnected', () => {
      useConnectionStore.getState().setConnecting('agent-123');
      useConnectionStore.getState().setConnected('/repo', false);
      useConnectionStore.getState().setDisconnected();
      const state = useConnectionStore.getState();
      expect(state.state).toBe('disconnected');
      expect(state.connectedAt).toBeNull();
      expect(state.reconnectAttempt).toBeNull();
      expect(state.agentOnline).toBeNull();
    });

    it('connected -> reconnecting', () => {
      useConnectionStore.getState().setConnecting('agent-123');
      useConnectionStore.getState().setConnected('/repo', false);
      useConnectionStore.getState().setReconnecting(1, 5);
      const state = useConnectionStore.getState();
      expect(state.state).toBe('reconnecting');
      expect(state.reconnectAttempt).toBe(1);
      expect(state.maxReconnectAttempts).toBe(5);
    });

    it('any state -> error', () => {
      useConnectionStore.getState().setConnecting('agent-123');
      useConnectionStore.getState().setError('Connection lost');
      const state = useConnectionStore.getState();
      expect(state.state).toBe('error');
      expect(state.error).toBe('Connection lost');
    });
  });

  describe('setAgentOnline', () => {
    it('only sets the agentOnline flag without changing state', () => {
      useConnectionStore.getState().setConnecting('agent-123');
      useConnectionStore.getState().setConnected('/repo', false);
      useConnectionStore.getState().setAgentOnline(true);
      const state = useConnectionStore.getState();
      expect(state.state).toBe('connected');
      expect(state.agentOnline).toBe(true);
    });

    it('can be set to false', () => {
      useConnectionStore.getState().setAgentOnline(false);
      expect(useConnectionStore.getState().agentOnline).toBe(false);
      // State should still be whatever it was
      expect(useConnectionStore.getState().state).toBe('disconnected');
    });
  });

  describe('setConnectionStep', () => {
    it('sets step and optional attempt', () => {
      useConnectionStore.getState().setConnectionStep('key-exchange', 2);
      const state = useConnectionStore.getState();
      expect(state.connectionStep).toBe('key-exchange');
      expect(state.keyExchangeAttempt).toBe(2);
    });

    it('sets step without attempt', () => {
      useConnectionStore.getState().setConnectionStep('handshake');
      const state = useConnectionStore.getState();
      expect(state.connectionStep).toBe('handshake');
      expect(state.keyExchangeAttempt).toBeNull();
    });
  });

  describe('reset', () => {
    it('returns to initial state', () => {
      // Set up some state
      useConnectionStore.getState().setConnecting('agent-123');
      useConnectionStore.getState().setConnected('/repo', true,
        [{ path: '/repo', name: 'repo' }], [], '1.0.0', '1.1.0', true);
      useConnectionStore.getState().setCodexModels([{ id: 'o4-mini', name: 'o4-mini' }]);
      useConnectionStore.getState().setAgentOnline(true);

      useConnectionStore.getState().reset();
      const state = useConnectionStore.getState();

      expect(state.state).toBe('disconnected');
      expect(state.agentId).toBeNull();
      expect(state.repoPath).toBeNull();
      expect(state.availableRepos).toEqual([]);
      expect(state.connectedAt).toBeNull();
      expect(state.error).toBeNull();
      expect(state.isPro).toBe(false);
      expect(state.agentVersion).toBeNull();
      expect(state.latestVersion).toBeNull();
      expect(state.codexModels).toEqual([]);
      expect(state.devBuild).toBe(false);
      expect(state.reconnectAttempt).toBeNull();
      expect(state.maxReconnectAttempts).toBeNull();
      expect(state.connectionStep).toBeNull();
      expect(state.keyExchangeAttempt).toBeNull();
      expect(state.agentOnline).toBeNull();
    });
  });

  describe('auxiliary setters', () => {
    it('setRepoPath updates repoPath', () => {
      useConnectionStore.getState().setRepoPath('/new/path');
      expect(useConnectionStore.getState().repoPath).toBe('/new/path');
    });

    it('setPendingRepoPath', () => {
      useConnectionStore.getState().setPendingRepoPath('/pending');
      expect(useConnectionStore.getState().pendingRepoPath).toBe('/pending');
    });

    it('setAvailableRepos', () => {
      useConnectionStore.getState().setAvailableRepos([{ path: '/a', name: 'a' }]);
      expect(useConnectionStore.getState().availableRepos).toHaveLength(1);
    });

    it('setCodexModels', () => {
      useConnectionStore.getState().setCodexModels([{ id: 'o3', name: 'o3' }]);
      expect(useConnectionStore.getState().codexModels).toEqual([{ id: 'o3', name: 'o3' }]);
    });
  });
});
