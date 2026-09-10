// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { MarkdownArtifactRef } from '@sumicom/quicksave-shared';
import {
  selectArtifactPreview,
  selectPanelMode,
  useSessionRightPanelStore,
} from './sessionRightPanelStore';

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

describe('sessionRightPanelStore artifact preview', () => {
  beforeEach(() => {
    useSessionRightPanelStore.setState({
      activeSessionId: null,
      sessionStates: {},
      panelWidth: 400,
    });
  });

  it('opens an artifact in the active session panel', () => {
    const store = useSessionRightPanelStore.getState();
    store.setActiveSession('session-1');
    store.openArtifactPreview(artifact);

    const state = useSessionRightPanelStore.getState();
    expect(selectPanelMode(state)).toBe('artifact');
    expect(selectArtifactPreview(state)).toEqual(artifact);
  });

  it('clears artifact state when the panel closes', () => {
    const store = useSessionRightPanelStore.getState();
    store.setActiveSession('session-1');
    store.openArtifactPreview(artifact);
    useSessionRightPanelStore.getState().close();

    const state = useSessionRightPanelStore.getState();
    expect(selectPanelMode(state)).toBeNull();
    expect(selectArtifactPreview(state)).toBeNull();
  });

  it('keeps previews isolated between sessions', () => {
    const store = useSessionRightPanelStore.getState();
    store.setActiveSession('session-1');
    store.openArtifactPreview(artifact);
    useSessionRightPanelStore.getState().setActiveSession('session-2');

    expect(selectArtifactPreview(useSessionRightPanelStore.getState())).toBeNull();
  });

  it('opens the voice debugger without toggling it closed', () => {
    const store = useSessionRightPanelStore.getState();
    store.setActiveSession('session-1');
    store.open('voice');
    useSessionRightPanelStore.getState().open('voice');

    expect(selectPanelMode(useSessionRightPanelStore.getState())).toBe('voice');
  });

  it('opens a panel for the route session even when another session is active', () => {
    const store = useSessionRightPanelStore.getState();
    store.setActiveSession('previous-session');
    store.open('files');

    useSessionRightPanelStore.getState().openForSession('route-session', 'settings');

    const state = useSessionRightPanelStore.getState();
    expect(state.activeSessionId).toBe('route-session');
    expect(selectPanelMode(state)).toBe('settings');
  });
});
