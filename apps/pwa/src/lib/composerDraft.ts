// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/** Small localStorage helpers for text-only composer drafts. Audio recovery is
 * kept separately in IndexedDB because it can be much larger. */

export function loadComposerDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function saveComposerDraft(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* localStorage can be blocked or quota-limited */
  }
}

export function clearComposerDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore unavailable localStorage */
  }
}
