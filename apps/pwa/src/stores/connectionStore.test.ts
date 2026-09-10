// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import { selectCodexModelsForAgent, selectOpenCodeModelsForAgent, useConnectionStore } from './connectionStore';

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
        [{ path: '/repo', name: 'repo' }], [], '1.0.0', '1.1.0');
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

    it('keeps Codex model catalogs isolated per machine', () => {
      const store = useConnectionStore.getState();
      store.setAgentConnected('machine-a', '/a', false);
      store.setAgentConnected('machine-b', '/b', false);
      store.setAgentCodexModels('machine-a', [{ id: 'gpt-6-astra', name: 'GPT-6-Astra' }]);
      store.setAgentCodexModels('machine-b', [{ id: 'gpt-5.5', name: 'GPT-5.5' }]);

      const state = useConnectionStore.getState();
      expect(selectCodexModelsForAgent(state, 'machine-a').map((model) => model.id)).toEqual(['gpt-6-astra']);
      expect(selectCodexModelsForAgent(state, 'machine-b').map((model) => model.id)).toEqual(['gpt-5.5']);
    });

    it('keeps refreshed OpenCode model catalogs isolated per machine', () => {
      const store = useConnectionStore.getState();
      store.setAgentConnected('machine-a', '/a', false);
      store.setAgentConnected('machine-b', '/b', false);
      store.setAgentAvailableProviders('machine-a', [{
        id: 'opencode', label: 'OpenCode', capabilities: {} as never,
        models: [{ id: 'thor/qwen3.8', name: 'Qwen 3.8', providerId: 'thor', providerName: 'Thor' }],
      }]);
      store.setAgentAvailableProviders('machine-b', [{
        id: 'opencode', label: 'OpenCode', capabilities: {} as never,
        models: [{ id: 'orin/qwen3.6', name: 'Qwen 3.6', providerId: 'orin', providerName: 'Orin' }],
      }]);

      const state = useConnectionStore.getState();
      expect(selectOpenCodeModelsForAgent(state, 'machine-a').map((model) => model.id)).toEqual(['thor/qwen3.8']);
      expect(selectOpenCodeModelsForAgent(state, 'machine-b').map((model) => model.id)).toEqual(['orin/qwen3.6']);
    });
  });

  describe('per-machine reconnect state', () => {
    it('keeps a reconnecting machine separate from healthy machines', () => {
      const store = useConnectionStore.getState();
      store.setAgentConnected('machine-a', '/a', false);
      store.setAgentConnected('machine-b', '/b', false);

      store.setAgentReconnecting('machine-a', 2, 5);
      store.setAgentConnectionStep('machine-a', 'key-exchange', 2);

      const state = useConnectionStore.getState();
      expect(state.agentConnections['machine-a']).toMatchObject({
        state: 'reconnecting', reconnectAttempt: 2, maxReconnectAttempts: 5,
        connectionStep: 'key-exchange', keyExchangeAttempt: 2,
      });
      expect(state.agentConnections['machine-b']).toMatchObject({
        state: 'connected', reconnectAttempt: null, connectionStep: null,
      });
    });

    it('retains a disconnected machine record without clearing healthy machines', () => {
      const store = useConnectionStore.getState();
      store.setAgentConnected('machine-a', '/a', false);
      store.setAgentConnected('machine-b', '/b', false);

      store.setAgentDisconnected('machine-a');

      const state = useConnectionStore.getState();
      expect(state.agentConnections['machine-a']).toMatchObject({ state: 'disconnected', online: false });
      expect(state.agentConnections['machine-b']).toMatchObject({ state: 'connected', repoPath: '/b' });
    });

    it('preserves a machine-local handshake error through peer cleanup', () => {
      const store = useConnectionStore.getState();
      store.setAgentConnecting('machine-a');
      store.setAgentError('machine-a', 'Stored machine public key is invalid');

      store.setAgentDisconnected('machine-a');

      expect(useConnectionStore.getState().agentConnections['machine-a']).toMatchObject({
        state: 'error', error: 'Stored machine public key is invalid',
      });
    });

    it('mirrors the selected machine even when it is offline', () => {
      const store = useConnectionStore.getState();
      store.setAgentConnected('machine-a', '/a', false);
      store.setAgentDisconnected('machine-a');

      store.setActiveAgentConnection('machine-a');

      const state = useConnectionStore.getState();
      expect(state.agentId).toBe('machine-a');
      expect(state.state).toBe('disconnected');
      expect(state.repoPath).toBe('/a');
    });

    it('clears a machine-local error when its handshake retries', () => {
      const store = useConnectionStore.getState();
      store.setAgentConnecting('machine-a');
      store.setAgentError('machine-a', 'key exchange failed');

      store.setAgentConnectionStep('machine-a', 'waiting-for-agent');

      expect(useConnectionStore.getState().agentConnections['machine-a']).toMatchObject({
        state: 'connecting', error: null, connectionStep: 'waiting-for-agent',
      });
    });

    it('records a socket-wide exhausted retry error for every affected machine', () => {
      const store = useConnectionStore.getState();
      store.setAgentConnected('machine-a', '/a', false);
      store.setAgentConnected('machine-b', '/b', false);

      store.setAllAgentsError('relay retry exhausted');

      expect(useConnectionStore.getState().agentConnections['machine-a']).toMatchObject({ state: 'error', error: 'relay retry exhausted' });
      expect(useConnectionStore.getState().agentConnections['machine-b']).toMatchObject({ state: 'error', error: 'relay retry exhausted' });

      store.setAllAgentsDisconnected();

      expect(useConnectionStore.getState().agentConnections['machine-a']).toMatchObject({ state: 'error', error: 'relay retry exhausted' });
      expect(useConnectionStore.getState().agentConnections['machine-b']).toMatchObject({ state: 'error', error: 'relay retry exhausted' });
    });
  });
});
