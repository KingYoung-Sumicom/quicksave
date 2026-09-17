// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../stores/sessionStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { registerAgentBusGetter } from '../../lib/busRegistry';
import type { OpenCodeConfigSnapshotResponsePayload } from '@sumicom/quicksave-shared';
import { SessionStatusBar } from './SessionStatusBar';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionStatusBar OpenCode model chip', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useSessionStore.getState().reset();
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
    useSessionStore.getState().reset();
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

    const sessionStore = useSessionStore.getState();
    sessionStore.upsertSession({ sessionId: 'ses-1', machineAgentId: 'machine-b' });
    sessionStore.setSessionConfigKey('ses-1', 'agent', 'opencode');
    sessionStore.setSessionConfigKey('ses-1', 'model', 'thor/qwen3.8');

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

    const sessionStore = useSessionStore.getState();
    sessionStore.upsertSession({ sessionId: 'ses-1', machineAgentId: 'machine-b' });
    sessionStore.setSessionConfigKey('ses-1', 'agent', 'opencode');
    sessionStore.setSessionConfigKey('ses-1', 'model', 'thor/qwen3.8');

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

    const sessionStore = useSessionStore.getState();
    sessionStore.upsertSession({ sessionId: 'ses-1', machineAgentId: 'machine-b' });
    sessionStore.setSessionConfigKey('ses-1', 'agent', 'opencode');
    sessionStore.setSessionConfigKey('ses-1', 'model', 'thor/qwen3.8');

    await act(async () => {
      root.render(<SessionStatusBar sessionId="ses-1" />);
    });

    expect(container.textContent).not.toContain('Qwen 3.8');
  });
});

function guardianSnapshot(
  guardian: OpenCodeConfigSnapshotResponsePayload['guardian'],
): OpenCodeConfigSnapshotResponsePayload {
  return {
    available: true,
    websearch: { exaEnabled: false, permission: 'unknown' },
    guardian,
    mcp: [],
    providers: [],
    agents: [],
    skills: [],
    commands: [],
    plugins: [],
  };
}

describe('SessionStatusBar guardian auto-open', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useSessionStore.getState().reset();
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
    useSessionStore.getState().reset();
    registerAgentBusGetter(null as never);
  });

  async function renderWithBus(snapshot: OpenCodeConfigSnapshotResponsePayload) {
    const command = vi.fn(async (type: string) => {
      if (type === 'opencode:config-snapshot') return snapshot;
      throw new Error(`unexpected command ${type}`);
    });
    registerAgentBusGetter((agentId) => (agentId === 'machine-b' ? ({ command } as never) : null));
    const sessionStore = useSessionStore.getState();
    sessionStore.upsertSession({ sessionId: 'ses-1', machineAgentId: 'machine-b' });
    sessionStore.setSessionConfigKey('ses-1', 'agent', 'opencode');
    sessionStore.setSessionConfigKey('ses-1', 'model', 'thor/qwen3.8');
    sessionStore.setSessionConfigKey('ses-1', 'permissionMode', 'auto');
    await act(async () => {
      root.render(<SessionStatusBar sessionId="ses-1" />);
    });
    return command;
  }

  async function selectAutoReview() {
    const permissionChip = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Yolo');
    expect(permissionChip).toBeTruthy();
    await act(async () => permissionChip!.click());
    const autoReviewOption = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Auto Review');
    expect(autoReviewOption).toBeTruthy();
    await act(async () => autoReviewOption!.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('opens the Guardian setup dialog when Auto Review is selected on an unconfigured machine', async () => {
    const command = await renderWithBus(guardianSnapshot({
      configured: false, source: 'none', hasApiKey: false, enableThinking: false,
      timeoutMs: 60_000, maxConsecutiveDenials: 3, serverState: { status: 'unknown' },
    }));
    await selectAutoReview();
    expect(command).toHaveBeenCalledWith(
      'opencode:config-snapshot', {}, expect.objectContaining({ timeoutMs: 30_000 }),
    );
    expect(container.querySelector('[role="dialog"][aria-label="Guardian settings"]')).toBeTruthy();
  });

  it('stays closed when the guardian is configured and the server was reachable', async () => {
    await renderWithBus(guardianSnapshot({
      configured: true, source: 'settings', baseUrl: 'http://localhost:8000/v1', model: 'reviewer',
      hasApiKey: false, enableThinking: false, timeoutMs: 60_000, maxConsecutiveDenials: 3,
      serverState: { status: 'ok', lastCheckedAt: 1 },
    }));
    await selectAutoReview();
    expect(container.querySelector('[role="dialog"][aria-label="Guardian settings"]')).toBeFalsy();
  });

  it('reopens the dialog when the stored server has become unreachable', async () => {
    await renderWithBus(guardianSnapshot({
      configured: true, source: 'settings', baseUrl: 'http://localhost:8000/v1', model: 'reviewer',
      hasApiKey: false, enableThinking: false, timeoutMs: 60_000, maxConsecutiveDenials: 3,
      serverState: { status: 'failed', lastError: 'guardian model server 503' },
    }));
    await selectAutoReview();
    expect(container.querySelector('[role="dialog"][aria-label="Guardian settings"]')).toBeTruthy();
    // The dialog pre-fills the stored endpoint so the user only has to test/fix it.
    const baseUrlInput = container.querySelector<HTMLInputElement>('[role="dialog"] input');
    expect(baseUrlInput?.value).toBe('http://localhost:8000/v1');
  });

  it('does not open the dialog when the machine is unreachable', async () => {
    const command = vi.fn(async (type: string) => { throw new Error('no bus for you'); });
    registerAgentBusGetter(() => ({ command } as never));
    const sessionStore = useSessionStore.getState();
    sessionStore.upsertSession({ sessionId: 'ses-1', machineAgentId: 'machine-b' });
    sessionStore.setSessionConfigKey('ses-1', 'agent', 'opencode');
    sessionStore.setSessionConfigKey('ses-1', 'permissionMode', 'auto');
    await act(async () => {
      root.render(<SessionStatusBar sessionId="ses-1" />);
    });
    await selectAutoReview();
    expect(container.querySelector('[role="dialog"][aria-label="Guardian settings"]')).toBeFalsy();
  });
});
