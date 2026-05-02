// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { create } from 'zustand';

const STORAGE_KEY = 'quicksave.uiPrefs';

interface PersistedShape {
  hideToolCalls?: boolean;
}

function load(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function save(state: PersistedShape) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage blocked or quota exceeded — drop silently
  }
}

interface UiPrefsStore {
  /** When true, consecutive tool-call cards collapse into a placeholder so
   *  only assistant/user messages render. Per-browser, default true. */
  hideToolCalls: boolean;
  setHideToolCalls: (next: boolean) => void;
  toggleHideToolCalls: () => void;
}

export const useUiPrefsStore = create<UiPrefsStore>((set, get) => {
  const persisted = load();
  return {
    hideToolCalls: persisted.hideToolCalls ?? true,
    setHideToolCalls: (next) => {
      save({ ...load(), hideToolCalls: next });
      set({ hideToolCalls: next });
    },
    toggleHideToolCalls: () => {
      const next = !get().hideToolCalls;
      save({ ...load(), hideToolCalls: next });
      set({ hideToolCalls: next });
    },
  };
});
