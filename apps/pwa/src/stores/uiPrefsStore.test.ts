// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from 'vitest';
import { useUiPrefsStore } from './uiPrefsStore';

describe('uiPrefsStore session history cache preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to enabled and persists the disabled choice locally', () => {
    expect(useUiPrefsStore.getState().sessionHistoryCacheEnabled).toBe(true);

    useUiPrefsStore.getState().setSessionHistoryCacheEnabled(false);

    expect(useUiPrefsStore.getState().sessionHistoryCacheEnabled).toBe(false);
    expect(JSON.parse(localStorage.getItem('quicksave.uiPrefs') ?? '{}'))
      .toMatchObject({ sessionHistoryCacheEnabled: false });
  });
});
