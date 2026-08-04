// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VoiceCapturePreparingOverlay } from './VoiceCapturePreparingOverlay';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('VoiceCapturePreparingOverlay', () => {
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

  it('announces microphone preparation without claiming recording is active', () => {
    act(() => root.render(<VoiceCapturePreparingOverlay />));

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-label')).toBe('Preparing microphone');
    expect(status?.textContent).toContain('Preparing microphone...');
    expect(status?.textContent).not.toContain('Recording');
  });
});
