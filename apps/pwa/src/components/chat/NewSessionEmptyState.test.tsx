// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useClaudeStore } from '../../stores/claudeStore';
import { useClaudeAuthStore } from '../../stores/claudeAuthStore';
import { useCodexLoginStore } from '../../stores/codexLoginStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { NewSessionEmptyState } from './NewSessionEmptyState';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('NewSessionEmptyState machine-scoped auth gates', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useClaudeStore.getState().reset();
    useClaudeStore.getState().setSelectedAgent('codex');
    useCodexLoginStore.setState({ byAgent: {} });
    useClaudeAuthStore.setState({ byAgent: {} });
    useConnectionStore.setState({ agentId: 'machine-a', codexModels: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    useClaudeStore.getState().reset();
    useCodexLoginStore.setState({ byAgent: {} });
    useClaudeAuthStore.setState({ byAgent: {} });
  });

  it('uses the selected project machine instead of the active machine', async () => {
    useCodexLoginStore.getState().set('machine-a', { loggedIn: false, inProgress: false });
    useCodexLoginStore.getState().set('machine-b', { loggedIn: true, inProgress: false });

    await renderFor('machine-b');

    expect(container.textContent).not.toContain('Codex is not signed in');
  });

  it('shows the gate only when the selected project machine is signed out', async () => {
    useCodexLoginStore.getState().set('machine-a', { loggedIn: true, inProgress: false });
    useCodexLoginStore.getState().set('machine-b', { loggedIn: false, inProgress: false });

    await renderFor('machine-b');

    expect(container.textContent).toContain('Codex is not signed in');
  });

  it('isolates Claude authentication by selected project machine', async () => {
    useClaudeStore.getState().setSelectedAgent('claude-code');
    useClaudeAuthStore.getState().set('machine-a', { loggedIn: false });
    useClaudeAuthStore.getState().set('machine-b', { loggedIn: true, method: 'claude.ai' });

    await renderFor('machine-b');

    expect(container.textContent).not.toContain('Claude is not signed in');
  });

  it('shows the Claude gate for a signed-out selected project machine', async () => {
    useClaudeStore.getState().setSelectedAgent('claude-terminal');
    useClaudeAuthStore.getState().set('machine-a', { loggedIn: true, method: 'claude.ai' });
    useClaudeAuthStore.getState().set('machine-b', { loggedIn: false });

    await renderFor('machine-b');

    expect(container.textContent).toContain('Claude is not signed in');
    expect(container.textContent).toContain('claude auth login');
  });

  async function renderFor(agentId: string) {
    await act(async () => {
      root.render(
        <IntlProvider
          locale="en"
          messages={{
            'newSession.agent': 'Agent',
            'newSession.title': 'New session',
            'newSession.hint': 'Choose settings and start chatting.',
            'codexLogin.banner.title': 'Codex is not signed in',
            'codexLogin.banner.body': 'Sign in on this machine.',
            'codexLogin.banner.button': 'Sign in',
            'claudeAuth.banner.title': 'Claude is not signed in',
            'claudeAuth.banner.body': 'Sign in on this machine.',
            'claudeAuth.banner.cliMissingTitle': 'Claude is unavailable.',
            'claudeAuth.banner.cliMissing': 'Claude is missing.',
            'claudeAuth.banner.unavailableTitle': 'Claude auth could not be checked.',
            'claudeAuth.banner.unavailable': 'Update Claude.',
            'claudeAuth.banner.refresh': 'Check again',
            'claudeAuth.banner.checking': 'Checking…',
          }}
        >
          <NewSessionEmptyState agentId={agentId} cwd="/workspace/project" />
        </IntlProvider>,
      );
    });
  }
});
