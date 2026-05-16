// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { create } from 'zustand';

/**
 * Global single-slot store for the file preview modal.
 *
 * Anywhere in the PWA can call `useFilePreviewStore.getState().open(...)`
 * to pop a modal showing the requested file. The modal itself is mounted
 * once at the app root and subscribes to this store.
 *
 * `cwd` is optional — when set, the modal uses it as a display anchor for
 * paths inside the project (relative breadcrumb), and as the resolution
 * base for relative paths sent to the agent. Absolute paths bypass cwd
 * entirely (the agent does not sandbox).
 */
export interface FilePreviewRequest {
  /** Display anchor + resolution base for relative paths. May be empty. */
  cwd: string;
  /** Path the agent will resolve. Absolute or relative-to-cwd. */
  path: string;
  /**
   * Agent that owns this file. When set, file ops go to this specific agent
   * (via getBusForAgent) instead of the currently-active one. Required for
   * the file browser where the URL agent may differ from the active agent.
   */
  agentId?: string;
  /** Optional override for the agent's preview byte cap. */
  maxBytes?: number;
}

interface FilePreviewStore {
  /** Currently-previewed file, or null when the modal is closed. */
  current: FilePreviewRequest | null;
  /** Desktop side-panel width in pixels. Persisted to localStorage. */
  panelWidth: number;
  open(req: FilePreviewRequest): void;
  close(): void;
  setPanelWidth(w: number): void;
}

const PANEL_WIDTH_KEY = 'quicksave.filePreview.panelWidth';
const DEFAULT_PANEL_WIDTH = 480;
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 1200;

function loadPanelWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_PANEL_WIDTH;
  const raw = window.localStorage?.getItem(PANEL_WIDTH_KEY);
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_PANEL_WIDTH;
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, n));
}

export const useFilePreviewStore = create<FilePreviewStore>((set) => ({
  current: null,
  panelWidth: loadPanelWidth(),
  open: (req) => set({ current: req }),
  close: () => set({ current: null }),
  setPanelWidth: (w) => {
    const clamped = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(w)));
    if (typeof window !== 'undefined') {
      try { window.localStorage?.setItem(PANEL_WIDTH_KEY, String(clamped)); } catch { /* ignore */ }
    }
    set({ panelWidth: clamped });
  },
}));

export const FILE_PREVIEW_PANEL_MIN = MIN_PANEL_WIDTH;
export const FILE_PREVIEW_PANEL_MAX = MAX_PANEL_WIDTH;
