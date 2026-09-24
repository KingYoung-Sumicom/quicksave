// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { IntlProvider } from 'react-intl';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../stores/sessionStore';
import { SessionPanel, scrollTopAfterPrepend, shouldReplaceComposerWithVoice } from './SessionPanel';

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

describe('SessionPanel composer acknowledgement', () => {
  let container: HTMLDivElement;
  let root: Root;
  let desktopViewport = true;

  beforeEach(() => {
    desktopViewport = true;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(min-width: 768px)' && desktopViewport,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    localStorage.clear();
    useSessionStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    useSessionStore.getState().reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('submits with Enter even when the browser exposes touch events', async () => {
    vi.stubGlobal('ontouchstart', null);
    const onStartSession = vi.fn().mockResolvedValue(true);
    localStorage.setItem('qs_draft_new', 'send with enter');
    await act(async () => {
      root.render(<SessionPanel
        newSession
        agentId="agent-1"
        onGetSessionCards={vi.fn().mockResolvedValue(undefined)}
        onStartSession={onStartSession}
        onResumeSession={vi.fn().mockResolvedValue(true)}
      />);
    });
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('send with enter');
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    });
    expect(onStartSession).not.toHaveBeenCalled();
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onStartSession).toHaveBeenCalledWith('send with enter', expect.any(Object));
  });

  it('leaves Enter available for a newline on mobile and sends from the button', async () => {
    desktopViewport = false;
    const onStartSession = vi.fn().mockResolvedValue(true);
    localStorage.setItem('qs_draft_new', 'first line');
    await act(async () => {
      root.render(<SessionPanel
        newSession
        agentId="agent-1"
        onGetSessionCards={vi.fn().mockResolvedValue(undefined)}
        onStartSession={onStartSession}
        onResumeSession={vi.fn().mockResolvedValue(true)}
      />);
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.getAttribute('enterkeyhint')).toBe('enter');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => { textarea.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(false);
    expect(onStartSession).not.toHaveBeenCalled();

    const send = container.querySelector('button[title="Send"]') as HTMLButtonElement;
    await act(async () => { send.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(onStartSession).toHaveBeenCalledWith('first line', expect.any(Object));
  });

  async function renderWithAck(ack: Promise<boolean>) {
    localStorage.setItem('qs_draft_new', 'message awaiting ack');
    await act(async () => {
      root.render(
        <SessionPanel
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

    // Providers can publish their user-card event before the command response
    // reaches this tab. It must remain hidden until that response is acked.
    await act(async () => {
      useSessionStore.getState().appendCard({
        type: 'user',
        id: 'agent-user-card',
        timestamp: Date.now(),
        text: 'message awaiting ack',
      });
    });
    expect(container.querySelector('[data-card-id="agent-user-card"]')).toBeNull();

    await act(async () => { ack.resolve(true); await ack.promise; });

    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('');
    expect(localStorage.getItem('qs_draft_new')).toBeNull();
    expect(container.querySelector('[data-card-id="agent-user-card"]')).not.toBeNull();
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

  it('defaults active-turn sends to queue and allows explicit insertion', async () => {
    const onResumeSession = vi.fn().mockResolvedValue(true);
    const state = useSessionStore.getState();
    state.upsertSession({ sessionId: 'active-codex', summary: 'test', lastModified: Date.now(), agent: 'codex', isActive: true, isStreaming: true });
    state.setActiveSession('active-codex');
    state.setStreaming(true);
    await act(async () => {
      root.render(<IntlProvider locale="en"><SessionPanel
        sessionId="active-codex"
        onGetSessionCards={vi.fn().mockResolvedValue(undefined)}
        onStartSession={vi.fn().mockResolvedValue(true)}
        onResumeSession={onResumeSession}
      /></IntlProvider>);
    });

    await act(async () => { useSessionStore.getState().setPromptInput('first'); });

    const mode = container.querySelector('select[aria-label="Message delivery mode"]') as HTMLSelectElement;
    expect(mode.value).toBe('queue');
    const send = container.querySelector('button[title="Send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => { send.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(onResumeSession).toHaveBeenCalledWith('active-codex', 'first', expect.objectContaining({ deliveryMode: 'queue' }));

    await act(async () => { useSessionStore.getState().setPromptInput('second'); });
    await act(async () => {
      mode.value = 'steer';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { send.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(onResumeSession).toHaveBeenLastCalledWith('active-codex', 'second', expect.objectContaining({ deliveryMode: 'steer' }));
  });
});

describe('SessionPanel voice workspace visibility', () => {
  it('replaces the composer only while the voice sidebar is active', () => {
    expect(shouldReplaceComposerWithVoice(true, 'voice')).toBe(true);
    expect(shouldReplaceComposerWithVoice(true, null)).toBe(false);
    expect(shouldReplaceComposerWithVoice(false, 'voice')).toBe(false);
  });
});

describe('SessionPanel history scroll restoration', () => {
  it('keeps the same content visible when prepended cards add height', () => {
    expect(scrollTopAfterPrepend(120, 800, 1100)).toBe(420);
  });

  it('does not request a scroll change when collapsed cards add no height', () => {
    expect(scrollTopAfterPrepend(120, 800, 800)).toBeNull();
  });
});

describe('SessionPanel empty native-item history pages', () => {
  it('advances a zero-card page with the opaque cursor and pauses after three empty pages', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(min-width: 768px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    useSessionStore.getState().reset();
    useSessionStore.getState().setActiveSession('empty-history');
    useSessionStore.getState().setHistoryMeta(undefined, true, 'cursor-0');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let onIntersect: IntersectionObserverCallback | undefined;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { onIntersect = callback; }
      observe() {}
      disconnect() {}
    });
    let page = 0;
    const onGetSessionCards = vi.fn(async (_sessionId: string, offset?: number) => {
      if (offset === undefined) return;
      expect(offset).toBe(1);
      useSessionStore.getState().setHistoryMeta(undefined, true, `cursor-${++page}`);
    });

    try {
      await act(async () => {
        root.render(<IntlProvider locale="en"><SessionPanel
          sessionId="empty-history"
          onGetSessionCards={onGetSessionCards}
          onStartSession={vi.fn().mockResolvedValue(true)}
          onResumeSession={vi.fn().mockResolvedValue(true)}
        /></IntlProvider>);
      });

      for (let index = 0; index < 3; index++) {
        expect(onIntersect).toBeDefined();
        await act(async () => { onIntersect!([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver); });
      }
      expect(page).toBe(3);
      expect(container.textContent).toContain('Load older messages');
      expect(onIntersect).toBeDefined();
      await act(async () => { onIntersect!([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver); });
      expect(page).toBe(3);

      const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('Load older messages'));
      await act(async () => { button?.click(); });
      expect(page).toBe(4);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useSessionStore.getState().reset();
      vi.unstubAllGlobals();
    }
  });
});
