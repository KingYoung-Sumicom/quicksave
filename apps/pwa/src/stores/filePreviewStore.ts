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
  /** Optional override for the agent's preview byte cap. */
  maxBytes?: number;
}

interface FilePreviewStore {
  /** Currently-previewed file, or null when the modal is closed. */
  current: FilePreviewRequest | null;
  open(req: FilePreviewRequest): void;
  close(): void;
}

export const useFilePreviewStore = create<FilePreviewStore>((set) => ({
  current: null,
  open: (req) => set({ current: req }),
  close: () => set({ current: null }),
}));
