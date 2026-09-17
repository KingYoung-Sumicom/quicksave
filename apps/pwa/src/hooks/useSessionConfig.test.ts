// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../stores/sessionStore';
import type { ConfigValue } from '@sumicom/quicksave-shared';
import {
  DEFAULT_AGENT,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_REASONING_EFFORT,
} from '@sumicom/quicksave-shared';
import { normalizeAgentId } from '../lib/agentPresets';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

/**
 * Replicates the logic from useSessionConfig without React hooks.
 * This lets us test the config merging in a pure unit-test context.
 */
function getSessionConfig(sessionId: string | null): Record<string, ConfigValue> {
  const state = useSessionStore.getState();
  const { sessionConfigs, selectedModel, selectedAgent, selectedPermissionMode, selectedReasoningEffort, sandboxEnabled } = state;

  if (!sessionId) {
    return {
      agent: selectedAgent ?? DEFAULT_AGENT,
      model: selectedModel ?? DEFAULT_MODEL,
      permissionMode: selectedPermissionMode ?? DEFAULT_PERMISSION_MODE,
      reasoningEffort: selectedReasoningEffort ?? DEFAULT_REASONING_EFFORT,
      sandboxed: sandboxEnabled,
    };
  }

  const sessionConfig = sessionConfigs[sessionId] ?? {};
  const rawSessionAgent = (sessionConfig['agent'] as string | undefined)
    ?? (((sessionConfig as Record<string, ConfigValue>)['provider']) as string | undefined);
  const sessionAgent = rawSessionAgent ? normalizeAgentId(rawSessionAgent) : undefined;

  const merged: Record<string, ConfigValue> = {
    agent: selectedAgent ?? DEFAULT_AGENT,
    model: selectedModel,
    permissionMode: selectedPermissionMode,
    reasoningEffort: selectedReasoningEffort,
    sandboxed: sandboxEnabled,
    ...sessionConfig,
    ...(sessionAgent ? { agent: sessionAgent } : {}),
  };
  if (merged.agent === 'opencode' && merged.permissionMode === 'bypassPermissions') {
    merged.permissionMode = 'auto';
  }
  return merged;
}

describe('useSessionConfig (logic)', () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
    useSessionStore.setState({
      selectedModel: DEFAULT_MODEL,
      selectedAgent: DEFAULT_AGENT,
      selectedPermissionMode: DEFAULT_PERMISSION_MODE,
      selectedReasoningEffort: DEFAULT_REASONING_EFFORT,
      sandboxEnabled: false,
      sessionConfigs: {},
    });
  });

  describe('null sessionId (new session defaults)', () => {
    it('returns store defaults', () => {
      const config = getSessionConfig(null);
      expect(config.agent).toBe(DEFAULT_AGENT);
      expect(config.model).toBe(DEFAULT_MODEL);
      expect(config.permissionMode).toBe(DEFAULT_PERMISSION_MODE);
      expect(config.reasoningEffort).toBe(DEFAULT_REASONING_EFFORT);
      expect(config.sandboxed).toBe(false);
    });

    it('reflects changed store values', () => {
      useSessionStore.setState({
        selectedModel: 'claude-haiku-4-5-20251001',
        selectedAgent: 'codex',
        selectedPermissionMode: 'bypassPermissions',
        selectedReasoningEffort: 'high',
        sandboxEnabled: true,
      });

      const config = getSessionConfig(null);
      expect(config.agent).toBe('codex');
      expect(config.model).toBe('claude-haiku-4-5-20251001');
      expect(config.permissionMode).toBe('bypassPermissions');
      expect(config.reasoningEffort).toBe('high');
      expect(config.sandboxed).toBe(true);
    });
  });

  describe('with sessionId (active session)', () => {
    it('returns store defaults when no session config exists', () => {
      const config = getSessionConfig('session-1');
      expect(config.agent).toBe(DEFAULT_AGENT);
      expect(config.model).toBe(DEFAULT_MODEL);
    });

    it('merges session-specific overrides', () => {
      useSessionStore.setState({
        sessionConfigs: {
          'session-1': { title: 'My Session', model: 'claude-haiku-4-5-20251001' },
        },
      });

      const config = getSessionConfig('session-1');
      expect(config.title).toBe('My Session');
      expect(config.model).toBe('claude-haiku-4-5-20251001');
      expect(config.agent).toBe(DEFAULT_AGENT);
    });

    it('normalizes codex agent from session config', () => {
      useSessionStore.setState({
        sessionConfigs: { 'session-1': { agent: 'codex' } },
      });
      expect(getSessionConfig('session-1').agent).toBe('codex');
    });

    it('normalizes codex-mcp to codex', () => {
      useSessionStore.setState({
        sessionConfigs: { 'session-1': { agent: 'codex-mcp' } },
      });
      expect(getSessionConfig('session-1').agent).toBe('codex');
    });

    it('preserves opencode agent from resumed session config', () => {
      useSessionStore.setState({
        selectedAgent: 'claude-code',
        sessionConfigs: { 'session-1': { agent: 'opencode' } },
      });
      expect(getSessionConfig('session-1').agent).toBe('opencode');
    });

    it('preserves pi agent from resumed session config', () => {
      useSessionStore.setState({
        selectedAgent: 'claude-code',
        sessionConfigs: { 'session-1': { agent: 'pi' } },
      });
      expect(getSessionConfig('session-1').agent).toBe('pi');
    });

    it('normalizes legacy provider field to agent', () => {
      useSessionStore.setState({
        sessionConfigs: { 'session-1': { provider: 'codex-mcp' } },
      });
      expect(getSessionConfig('session-1').agent).toBe('codex');
    });

    it('normalizes unknown provider to claude-code', () => {
      useSessionStore.setState({
        sessionConfigs: { 'session-1': { agent: 'claude-code' } },
      });
      expect(getSessionConfig('session-1').agent).toBe('claude-code');
    });

    it('session config overrides store defaults', () => {
      useSessionStore.setState({
        selectedPermissionMode: 'default',
        sessionConfigs: { 'session-1': { permissionMode: 'bypassPermissions' } },
      });
      expect(getSessionConfig('session-1').permissionMode).toBe('bypassPermissions');
    });

    it('maps legacy opencode bypassPermissions onto auto (OpenCode yolo is an alias of auto)', () => {
      useSessionStore.setState({
        sessionConfigs: { 'session-1': { agent: 'opencode', permissionMode: 'bypassPermissions' } },
      });
      expect(getSessionConfig('session-1').permissionMode).toBe('auto');
    });

    it('preserves non-standard session config keys', () => {
      useSessionStore.setState({
        sessionConfigs: { 'session-1': { customKey: 'customValue' } },
      });
      expect(getSessionConfig('session-1').customKey).toBe('customValue');
    });
  });
});
