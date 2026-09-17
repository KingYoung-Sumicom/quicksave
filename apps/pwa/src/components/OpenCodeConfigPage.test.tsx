// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCodeConfigSnapshotResponsePayload } from '@sumicom/quicksave-shared';
import { OpenCodeConfigPage } from './OpenCodeConfigPage';
import { useConnectionStore } from '../stores/connectionStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseSnapshot: OpenCodeConfigSnapshotResponsePayload = {
  available: true,
  version: '1.18.4',
  schema: 'v1',
  websearch: { exaEnabled: false, permission: 'unknown' },
  guardian: {
    configured: false,
    source: 'none',
    hasApiKey: false,
    enableThinking: false,
    timeoutMs: 60_000,
    maxConsecutiveDenials: 3,
    serverState: { status: 'unknown' },
  },
  mcp: [],
  providers: [],
  agents: [],
  skills: [],
  commands: [],
  plugins: [],
};

describe('OpenCodeConfigPage Guardian settings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useConnectionStore.getState().reset();
    useConnectionStore.getState().setAgentConnected('machine-a', '/repo', false);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(snapshot: OpenCodeConfigSnapshotResponsePayload, onTestGuardian?: (draft: { baseUrl: string; model: string; apiKey?: string }) => Promise<{ success: boolean; configured: boolean; error?: string; latencyMs?: number }>) {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/settings/m/machine-a/opencode']}>
          <Routes>
            <Route path="/settings/m/:agentId/opencode" element={
              <OpenCodeConfigPage
                onGetSnapshot={vi.fn().mockResolvedValue(snapshot)}
                onUpsertMcp={vi.fn()}
                onSetWebSearch={vi.fn()}
                onSetGuardian={vi.fn()}
                onTestGuardian={onTestGuardian ?? vi.fn().mockResolvedValue({ success: true, configured: true, latencyMs: 12 })}
              />
            } />
          </Routes>
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
  }

  async function openGuardianEditor() {
    const configure = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Configure' || button.textContent === 'Edit');
    expect(configure).toBeTruthy();
    await act(async () => configure!.click());
    expect(container.querySelector('[role="dialog"][aria-label="Guardian settings"]')).toBeTruthy();
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('shows Guardian status and opens the machine-local settings editor', async () => {
    await render(baseSnapshot);
    expect(container.textContent).toContain('Guardian auto-review');
    expect(container.textContent).toContain('Not configured');
    const configure = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Configure');
    expect(configure).toBeTruthy();
    await act(async () => configure!.click());
    expect(container.querySelector('[role="dialog"][aria-label="Guardian settings"]')).toBeTruthy();
    expect(container.textContent).toContain('OpenAI-compatible chat completions server');
    const thinking = container.querySelector<HTMLInputElement>('[role="switch"][aria-label="Enable model thinking"]');
    expect(thinking?.checked).toBe(false);
    await act(async () => thinking!.click());
    expect(thinking?.checked).toBe(true);
  });

  it('marks environment-managed settings read-only', async () => {
    await render({
      ...baseSnapshot,
      guardian: {
        configured: true,
        source: 'environment',
        baseUrl: 'https://review.example/v1',
        model: 'reviewer',
        hasApiKey: true,
        enableThinking: true,
        timeoutMs: 30_000,
        maxConsecutiveDenials: 2,
        serverState: { status: 'unknown' },
      },
    });
    const environment = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Environment');
    expect(environment?.disabled).toBe(true);
    expect(container.textContent).toContain('Managed by QUICKSAVE_GUARDIAN_* environment variables.');
  });

  it('flags an unreachable reviewer server with the last failure reason', async () => {
    await render({
      ...baseSnapshot,
      guardian: {
        configured: true,
        source: 'settings',
        baseUrl: 'http://localhost:8000/v1',
        model: 'reviewer',
        hasApiKey: false,
        enableThinking: false,
        timeoutMs: 60_000,
        maxConsecutiveDenials: 3,
        serverState: { status: 'failed', lastError: 'guardian model server 503: bad gateway' },
      },
    });
    expect(container.textContent).toContain('Configured');
    expect(container.textContent).toContain('Server unreachable');
    expect(container.textContent).toContain('Last failure: guardian model server 503: bad gateway');
  });

  it('hides the server-unreachable chip while the last check was ok', async () => {
    await render({
      ...baseSnapshot,
      guardian: {
        configured: true,
        source: 'settings',
        baseUrl: 'http://localhost:8000/v1',
        model: 'reviewer',
        hasApiKey: false,
        enableThinking: false,
        timeoutMs: 60_000,
        maxConsecutiveDenials: 3,
        serverState: { status: 'ok', lastCheckedAt: 1 },
      },
    });
    expect(container.textContent).not.toContain('Server unreachable');
  });

  it('tests the reviewer server from the settings dialog and reports the outcome', async () => {
    const onTestGuardian = vi.fn(async (draft: { baseUrl: string; model: string }) => ({
      success: true, configured: true, latencyMs: 33,
    }));
    await render(baseSnapshot, onTestGuardian);
    await openGuardianEditor();

    const dialog = container.querySelector('[role="dialog"][aria-label="Guardian settings"]')!;
    const inputs = dialog.querySelectorAll<HTMLInputElement>('input');
    const baseUrlInput = inputs[0];
    const modelInput = inputs[1];
    setInputValue(baseUrlInput, 'http://localhost:8000/v1');
    setInputValue(modelInput, 'reviewer');

    const testButton = [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent === 'Test');
    expect(testButton).toBeTruthy();
    await act(async () => testButton!.click());
    await act(async () => { await Promise.resolve(); });

    expect(onTestGuardian).toHaveBeenCalledWith({ baseUrl: 'http://localhost:8000/v1', model: 'reviewer' });
    expect(container.textContent).toContain('Connected · 33ms');
  });

  it('shows the failure reason when the reviewer server rejects the test', async () => {
    const onTestGuardian = vi.fn(async () => ({
      success: false, configured: true, error: 'guardian model server timed out',
    }));
    await render(baseSnapshot, onTestGuardian);
    await openGuardianEditor();

    const dialog = container.querySelector('[role="dialog"][aria-label="Guardian settings"]')!;
    const inputs = dialog.querySelectorAll<HTMLInputElement>('input');
    setInputValue(inputs[0], 'http://localhost:8000/v1');
    setInputValue(inputs[1], 'reviewer');

    const testButton = [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent === 'Test');
    await act(async () => testButton!.click());
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain('Test failed: guardian model server timed out');
  });

  it('disables the Test button until both draft fields are filled', async () => {
    await render(baseSnapshot);
    await openGuardianEditor();
    const dialog = container.querySelector('[role="dialog"][aria-label="Guardian settings"]')!;
    const testButton = [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent === 'Test')!;
    expect(testButton.disabled).toBe(true);
    setInputValue(dialog.querySelectorAll<HTMLInputElement>('input')[0], 'http://localhost:8000/v1');
    expect(testButton.disabled).toBe(true);
    setInputValue(dialog.querySelectorAll<HTMLInputElement>('input')[1], 'reviewer');
    expect(testButton.disabled).toBe(false);
  });
});
