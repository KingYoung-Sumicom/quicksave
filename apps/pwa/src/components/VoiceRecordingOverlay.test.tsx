// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceRecordingOverlay } from './VoiceRecordingOverlay';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('VoiceRecordingOverlay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('exposes separate stop and discard actions', () => {
    const onStop = vi.fn();
    const onCancel = vi.fn();
    act(() => root.render(<VoiceRecordingOverlay onStop={onStop} onCancel={onCancel} />));

    const buttons = [...container.querySelectorAll('button')];
    act(() => buttons.find((button) => button.textContent?.includes('Stop'))?.click());
    act(() => buttons.find((button) => button.textContent?.includes('Cancel'))?.click());

    expect(onStop).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
