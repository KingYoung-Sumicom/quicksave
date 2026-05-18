// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { create } from 'zustand';

export type SessionPanelMode = null | 'files' | 'git' | 'settings';

export interface FilesPreview {
  path: string;
  agentId: string;
  cwd: string;
}

interface PerSessionPanelState {
  mode: SessionPanelMode;
  filesRelPath: string;
  filesPreview: FilesPreview | null;
}

const DEFAULT_SESSION_STATE: PerSessionPanelState = {
  mode: null,
  filesRelPath: '',
  filesPreview: null,
};

interface SessionRightPanelStore {
  /** Which session's panel is currently mounted. Null when not on a session page. */
  activeSessionId: string | null;
  /** Per-session panel state. Preserved across navigation so returning to a
   *  session restores the panel in the same mode/position. */
  sessionStates: Record<string, PerSessionPanelState>;
  /** Desktop panel width — shared across sessions (user's preferred size). */
  panelWidth: number;

  /** Called by SessionRightPanel on mount/unmount to track which session is live. */
  setActiveSession(id: string | null): void;
  /** Toggle a panel tab for the current session. Same tab = close. */
  toggle(m: 'files' | 'git' | 'settings'): void;
  /** Close the panel for the current session. */
  close(): void;
  setPanelWidth(w: number): void;
  navigateFiles(relPath: string): void;
  openFilePreview(preview: FilesPreview): void;
  closeFilePreview(): void;
}

const PANEL_WIDTH_KEY = 'quicksave.sessionPanel.panelWidth';
const DEFAULT_PANEL_WIDTH = 400;
export const SESSION_PANEL_MIN = 280;
export const SESSION_PANEL_MAX = 1200;

function loadPanelWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_PANEL_WIDTH;
  const raw = window.localStorage?.getItem(PANEL_WIDTH_KEY);
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_PANEL_WIDTH;
  return Math.min(SESSION_PANEL_MAX, Math.max(SESSION_PANEL_MIN, n));
}

function getSession(s: SessionRightPanelStore): PerSessionPanelState {
  return s.activeSessionId
    ? (s.sessionStates[s.activeSessionId] ?? DEFAULT_SESSION_STATE)
    : DEFAULT_SESSION_STATE;
}

function updateSession(
  s: SessionRightPanelStore,
  patch: Partial<PerSessionPanelState>,
): Partial<SessionRightPanelStore> {
  const id = s.activeSessionId;
  if (!id) return {};
  return {
    sessionStates: {
      ...s.sessionStates,
      [id]: { ...getSession(s), ...patch },
    },
  };
}

export const useSessionRightPanelStore = create<SessionRightPanelStore>((set) => ({
  activeSessionId: null,
  sessionStates: {},
  panelWidth: loadPanelWidth(),

  setActiveSession: (id) => set({ activeSessionId: id }),

  toggle: (m) =>
    set((s) => {
      const curr = getSession(s);
      const newMode = curr.mode === m ? null : m;
      return updateSession(s, {
        mode: newMode,
        filesPreview: null,
        // Keep filesRelPath when toggling files tab back on; reset for other tabs.
        filesRelPath: newMode === 'files' ? curr.filesRelPath : '',
      });
    }),

  close: () => set((s) => updateSession(s, { mode: null, filesPreview: null })),

  setPanelWidth: (w) => {
    const clamped = Math.min(SESSION_PANEL_MAX, Math.max(SESSION_PANEL_MIN, Math.round(w)));
    try { window.localStorage?.setItem(PANEL_WIDTH_KEY, String(clamped)); } catch { /* ignore */ }
    set({ panelWidth: clamped });
  },

  navigateFiles: (relPath) => set((s) => updateSession(s, { filesRelPath: relPath, filesPreview: null })),
  openFilePreview: (preview) => set((s) => updateSession(s, { filesPreview: preview })),
  closeFilePreview: () => set((s) => updateSession(s, { filesPreview: null })),
}));

/** Selector: current session's panel mode (null when not on a session page). */
export function selectPanelMode(s: SessionRightPanelStore): SessionPanelMode {
  return getSession(s).mode;
}

/** Selector: current session's files preview request. */
export function selectFilesPreview(s: SessionRightPanelStore): FilesPreview | null {
  return getSession(s).filesPreview;
}

/** Selector: current session's directory path in the file browser. */
export function selectFilesRelPath(s: SessionRightPanelStore): string {
  return getSession(s).filesRelPath;
}
