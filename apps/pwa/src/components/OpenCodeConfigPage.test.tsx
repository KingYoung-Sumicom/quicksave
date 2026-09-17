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

  async function render(snapshot: OpenCodeConfigSnapshotResponsePayload) {
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
              />
            } />
          </Routes>
        </MemoryRouter>,
      );
      await Promise.resolve();
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
      },
    });
    const environment = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Environment');
    expect(environment?.disabled).toBe(true);
    expect(container.textContent).toContain('Managed by QUICKSAVE_GUARDIAN_* environment variables.');
  });
});
