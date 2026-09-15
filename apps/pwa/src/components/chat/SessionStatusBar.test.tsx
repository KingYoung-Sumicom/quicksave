// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useClaudeStore } from '../../stores/claudeStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { SessionStatusBar } from './SessionStatusBar';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionStatusBar OpenCode model chip', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useClaudeStore.getState().reset();
    useConnectionStore.setState({
      agentId: 'machine-a',
      codexModels: [],
      opencodeModels: [],
      availableProviders: [],
      agentConnections: {},
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    useClaudeStore.getState().reset();
  });

  it('shows the session machine’s OpenCode model even when the flat mirror is stale', async () => {
    const store = useConnectionStore.getState();
    store.setAgentConnected('machine-a', '/a', false);
    store.setAgentConnected('machine-b', '/b', false);
    store.setAgentAvailableProviders('machine-b', [{
      id: 'opencode',
      label: 'OpenCode',
      capabilities: {
        hasApiKey: false, hasCli: true, hasPlugin: false,
        supportsResume: true, supportsSandbox: false, supportsStreaming: true,
        supportsAttachments: true, supportedAttachmentKinds: ['image', 'pdf', 'text'],
      },
      models: [{ id: 'thor/qwen3.8', name: 'Qwen 3.8', providerId: 'thor', providerName: 'Thor' }],
    }]);
    // Precondition: the legacy flat mirror never picked up machine-b's
    // catalog because machine-a is the active agent.
    expect(useConnectionStore.getState().opencodeModels).toEqual([]);

    const claudeStore = useClaudeStore.getState();
    claudeStore.upsertSession({ sessionId: 'ses-1', machineAgentId: 'machine-b' });
    claudeStore.setSessionConfigKey('ses-1', 'agent', 'opencode');
    claudeStore.setSessionConfigKey('ses-1', 'model', 'thor/qwen3.8');

    await act(async () => {
      root.render(<SessionStatusBar sessionId="ses-1" />);
    });

    expect(container.textContent).toContain('Qwen 3.8');
  });

  it('splits the grouped catalog into provider and model chips', async () => {
    const store = useConnectionStore.getState();
    store.setAgentConnected('machine-b', '/b', false);
    store.setAgentAvailableProviders('machine-b', [{
      id: 'opencode',
      label: 'OpenCode',
      capabilities: {
        hasApiKey: false, hasCli: true, hasPlugin: false,
        supportsResume: true, supportsSandbox: false, supportsStreaming: true,
        supportsAttachments: true, supportedAttachmentKinds: ['image', 'pdf', 'text'],
      },
      models: [
        { id: 'thor/qwen3.8', name: 'Qwen 3.8', providerId: 'thor', providerName: 'Thor' },
        { id: 'vllm/llama-4', name: 'Llama 4', providerId: 'vllm', providerName: 'vLLM' },
      ],
    }]);

    const claudeStore = useClaudeStore.getState();
    claudeStore.upsertSession({ sessionId: 'ses-1', machineAgentId: 'machine-b' });
    claudeStore.setSessionConfigKey('ses-1', 'agent', 'opencode');
    claudeStore.setSessionConfigKey('ses-1', 'model', 'thor/qwen3.8');

    await act(async () => {
      root.render(<SessionStatusBar sessionId="ses-1" />);
    });

    expect(container.textContent).toContain('Thor');
    expect(container.textContent).toContain('Qwen 3.8');
    expect(container.textContent).not.toContain('Llama 4');
  });

  it('does not borrow another machine’s OpenCode catalog', async () => {
    const store = useConnectionStore.getState();
    store.setAgentConnected('machine-a', '/a', false);
    store.setAgentConnected('machine-b', '/b', false);
    store.setAgentAvailableProviders('machine-a', [{
      id: 'opencode',
      label: 'OpenCode',
      capabilities: {
        hasApiKey: false, hasCli: true, hasPlugin: false,
        supportsResume: true, supportsSandbox: false, supportsStreaming: true,
        supportsAttachments: true, supportedAttachmentKinds: ['image', 'pdf', 'text'],
      },
      models: [{ id: 'thor/qwen3.8', name: 'Qwen 3.8', providerId: 'thor', providerName: 'Thor' }],
    }]);
    // Flat mirror holds machine-a's catalog (it is the active agent), but
    // the session lives on machine-b, which has no OpenCode provider.
    expect(useConnectionStore.getState().opencodeModels.length).toBe(1);

    const claudeStore = useClaudeStore.getState();
    claudeStore.upsertSession({ sessionId: 'ses-1', machineAgentId: 'machine-b' });
    claudeStore.setSessionConfigKey('ses-1', 'agent', 'opencode');
    claudeStore.setSessionConfigKey('ses-1', 'model', 'thor/qwen3.8');

    await act(async () => {
      root.render(<SessionStatusBar sessionId="ses-1" />);
    });

    expect(container.textContent).not.toContain('Qwen 3.8');
  });
});
