// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownArtifactRef } from '@sumicom/quicksave-shared';
import { useSessionRightPanelStore } from '../../stores/sessionRightPanelStore';
import { ArtifactMessage } from './ArtifactMessage';

const mocks = vi.hoisted(() => ({
  isDesktop: true,
  useArtifactContent: vi.fn(() => ({
    status: 'ready' as const,
    artifact: {
      id: 'artifact-1',
      kind: 'markdown' as const,
      mimeType: 'text/markdown' as const,
      contentBase64: '',
    },
    markdown: '# Full report',
  })),
}));

vi.mock('../../hooks/useMediaQuery', () => ({
  useMediaQuery: () => mocks.isDesktop,
}));

vi.mock('../../hooks/useArtifactContent', () => ({
  useArtifactContent: mocks.useArtifactContent,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const artifact: MarkdownArtifactRef = {
  refKind: 'artifact',
  kind: 'markdown',
  artifactId: 'artifact-1',
  sessionId: 'session-1',
  cwd: '/project',
  title: 'Report',
  mimeType: 'text/markdown',
  size: 42,
  createdAt: 123,
};

describe('ArtifactMessage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isDesktop = true;
    mocks.useArtifactContent.mockClear();
    useSessionRightPanelStore.setState({
      activeSessionId: 'session-1',
      sessionStates: {},
      panelWidth: 400,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders metadata without fetching content, then opens the desktop panel', async () => {
    await act(async () => {
      root.render(<ArtifactMessage artifact={artifact} />);
    });

    expect(container.textContent).toContain('Report');
    expect(container.textContent).toContain('42 B · Markdown');
    expect(container.textContent).not.toContain('Full report');
    expect(mocks.useArtifactContent).not.toHaveBeenCalled();

    await act(async () => {
      container.querySelector('button')?.click();
    });

    const state = useSessionRightPanelStore.getState();
    expect(state.sessionStates['session-1']?.mode).toBe('artifact');
    expect(state.sessionStates['session-1']?.artifactPreview).toEqual(artifact);
    expect(mocks.useArtifactContent).not.toHaveBeenCalled();
  });

  it('opens a full-screen preview on mobile', async () => {
    mocks.isDesktop = false;
    await act(async () => {
      root.render(<ArtifactMessage artifact={artifact} />);
    });
    await act(async () => {
      container.querySelector('button')?.click();
    });

    expect(document.body.textContent).toContain('Full report');
    expect(mocks.useArtifactContent).toHaveBeenCalledWith('session-1', 'artifact-1');
  });
});
