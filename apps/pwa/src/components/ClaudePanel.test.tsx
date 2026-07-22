// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useClaudeStore } from '../stores/claudeStore';
import { ClaudePanel } from './ClaudePanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../hooks/useComposerVoice', () => ({
  useComposerVoice: () => ({
    recording: false,
    busy: false,
    streaming: false,
    interim: '',
    showMic: false,
    unavailable: false,
    configured: false,
    onMicPress: vi.fn(),
  }),
}));

vi.mock('../hooks/useVoiceAgent', () => ({
  useVoiceAgent: () => ({ enabled: false }),
}));

vi.mock('./chat/NewSessionEmptyState', () => ({
  NewSessionEmptyState: () => <div />,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('ClaudePanel composer acknowledgement', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useClaudeStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    useClaudeStore.getState().reset();
    vi.restoreAllMocks();
  });

  async function renderWithAck(ack: Promise<boolean>) {
    localStorage.setItem('qs_draft_new', 'message awaiting ack');
    await act(async () => {
      root.render(
        <ClaudePanel
          newSession
          agentId="agent-1"
          onGetSessionCards={vi.fn().mockResolvedValue(undefined)}
          onStartSession={vi.fn(() => ack)}
          onResumeSession={vi.fn().mockResolvedValue(true)}
        />,
      );
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const send = container.querySelector('button[title="Send"]') as HTMLButtonElement;
    expect(textarea.value).toBe('message awaiting ack');
    return { textarea, send };
  }

  it('persists and disables the message until a successful ack, then clears it', async () => {
    const ack = deferred<boolean>();
    const { textarea, send } = await renderWithAck(ack.promise);

    await act(async () => {
      send.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await Promise.resolve();
    });

    expect(textarea.disabled).toBe(true);
    expect(textarea.value).toBe('message awaiting ack');
    expect(localStorage.getItem('qs_draft_new')).toBe('message awaiting ack');

    await act(async () => { ack.resolve(true); await ack.promise; });

    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('');
    expect(localStorage.getItem('qs_draft_new')).toBeNull();
  });

  it('unlocks but retains the persisted message when the agent rejects it', async () => {
    const ack = deferred<boolean>();
    const { textarea, send } = await renderWithAck(ack.promise);

    await act(async () => {
      send.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => { ack.resolve(false); await ack.promise; });

    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('message awaiting ack');
    expect(localStorage.getItem('qs_draft_new')).toBe('message awaiting ack');
  });
});
