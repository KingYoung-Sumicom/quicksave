// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceTranscriptionOverlay } from './VoiceTranscriptionOverlay';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('VoiceTranscriptionOverlay', () => {
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

  it('announces transcription progress and renders activity bars', () => {
    act(() => root.render(<VoiceTranscriptionOverlay />));

    const region = container.querySelector('[role="region"]');
    const status = container.querySelector('[role="status"]');
    expect(region?.getAttribute('aria-label')).toBe('Transcribing voice');
    expect(status?.textContent).toContain('Transcribing...');
    expect(status?.querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(5);
  });

  it('keeps the overlay open with retry and cancel actions after timeout', () => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    act(() => root.render(
      <VoiceTranscriptionOverlay
        error="Transcription timed out."
        onRetry={onRetry}
        onCancel={onCancel}
      />,
    ));

    const buttons = [...container.querySelectorAll('button')];
    act(() => buttons.find((button) => button.textContent === 'Retry')?.click());
    act(() => buttons.find((button) => button.textContent === 'Cancel')?.click());

    expect(container.textContent).toContain('Transcription timed out.');
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
