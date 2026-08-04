// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseComposerVoice } from './useComposerVoice';

const mocks = vi.hoisted(() => ({
  mode: 'streaming' as 'streaming' | 'batch',
  recorderState: 'idle' as 'idle' | 'recording',
  recorderStop: vi.fn(),
  recorderCancel: vi.fn(),
  streamRecording: false,
  streamStart: vi.fn(),
  streamStop: vi.fn(),
  streamRetry: vi.fn(),
  onStreamFinal: null as ((text: string) => void) | null,
  transcribe: vi.fn(),
}));

vi.mock('../stores/connectionStore', () => ({
  useConnectionStore: (selector: (state: unknown) => unknown) => selector({
    agentConnections: { agent: { audio: { streaming: true, transcription: true } } },
  }),
}));
vi.mock('../lib/secureStorage', () => ({
  getVoiceConfig: vi.fn(async () => ({ mode: mocks.mode })),
}));
vi.mock('../lib/voiceTranscription', () => ({
  isVoiceConfigUsable: () => true,
  transcribeViaAgent: (...args: unknown[]) => mocks.transcribe(...args),
}));
vi.mock('../lib/voiceAgentClient', () => ({ logVoiceEvent: vi.fn() }));
vi.mock('./useVoiceRecorder', () => ({
  useVoiceRecorder: () => ({
    state: mocks.recorderState,
    start: vi.fn(),
    stop: mocks.recorderStop,
    cancel: mocks.recorderCancel,
  }),
}));
vi.mock('./useVoiceStream', () => ({
  useVoiceStream: (_agentId: string, onFinal: (text: string) => void) => {
    mocks.onStreamFinal = onFinal;
    return {
      ready: true,
      recording: mocks.streamRecording,
      unavailable: false,
      interim: '',
      error: null,
      ensure: vi.fn(async () => true),
      start: mocks.streamStart,
      stop: mocks.streamStop,
      retryTranscription: mocks.streamRetry,
      interruptPlayback: vi.fn(),
      disconnect: vi.fn(),
    };
  },
}));

import { useComposerVoice } from './useComposerVoice';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useComposerVoice post-stop transcription state', () => {
  let container: HTMLDivElement;
  let root: Root;
  let voice: UseComposerVoice;
  let onTranscript: ReturnType<typeof vi.fn>;

  function Harness() {
    voice = useComposerVoice('agent', onTranscript, vi.fn());
    return (
      <div
        data-arming={String(voice.arming)}
        data-transcribing={String(voice.transcribing)}
        data-error={voice.transcriptionError ?? ''}
      />
    );
  }

  beforeEach(async () => {
    mocks.mode = 'streaming';
    mocks.recorderState = 'idle';
    mocks.streamRecording = false;
    mocks.onStreamFinal = null;
    mocks.recorderStop.mockReset();
    mocks.recorderCancel.mockReset();
    mocks.streamStop.mockReset();
    mocks.streamRetry.mockReset();
    mocks.streamStart.mockReset().mockResolvedValue(true);
    mocks.transcribe.mockReset();
    onTranscript = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('stays in preparation until streaming capture reports its first frame', async () => {
    let resolveStart!: (ready: boolean) => void;
    mocks.streamStart.mockReturnValue(new Promise<boolean>((resolve) => { resolveStart = resolve; }));

    await act(async () => root.render(<Harness />));
    act(() => { void voice.onMicPress(); });
    await act(async () => { await Promise.resolve(); });

    expect(mocks.streamStart).toHaveBeenCalledOnce();
    expect(container.firstElementChild?.getAttribute('data-arming')).toBe('true');

    await act(async () => { resolveStart(true); });
    expect(container.firstElementChild?.getAttribute('data-arming')).toBe('false');
  });

  it('covers the composer immediately while a batch recorder is stopping', async () => {
    mocks.mode = 'batch';
    mocks.recorderState = 'recording';
    let resolveStop!: (blob: Blob) => void;
    mocks.recorderStop.mockReturnValue(new Promise<Blob>((resolve) => { resolveStop = resolve; }));
    mocks.transcribe.mockResolvedValue('done');

    await act(async () => root.render(<Harness />));
    await act(async () => { void voice.onMicPress(); });

    expect(container.firstElementChild?.getAttribute('data-transcribing')).toBe('true');

    await act(async () => { resolveStop(new Blob(['audio'])); });
    expect(onTranscript).toHaveBeenCalledWith('done');
    expect(container.firstElementChild?.getAttribute('data-transcribing')).toBe('false');
  });

  it('stays covered after streaming stop until the final transcript is committed', async () => {
    vi.useFakeTimers();
    mocks.streamRecording = true;

    await act(async () => root.render(<Harness />));
    await act(async () => { void voice.onMicPress(); });

    expect(mocks.streamStop).toHaveBeenCalledOnce();
    expect(container.firstElementChild?.getAttribute('data-transcribing')).toBe('true');

    act(() => mocks.onStreamFinal?.('finished words'));
    await act(async () => { vi.advanceTimersByTime(1_500); });

    expect(onTranscript).toHaveBeenCalledWith('finished words');
    expect(container.firstElementChild?.getAttribute('data-transcribing')).toBe('false');
  });

  it('discards streaming capture without entering transcription', async () => {
    mocks.streamRecording = true;

    await act(async () => root.render(<Harness />));
    act(() => voice.cancelListening());

    expect(mocks.streamStop).toHaveBeenCalledWith(expect.objectContaining({ discard: true }));
    expect(container.firstElementChild?.getAttribute('data-transcribing')).toBe('false');
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('keeps the streaming overlay open on timeout and retries retained audio', async () => {
    vi.useFakeTimers();
    mocks.streamRecording = true;

    await act(async () => root.render(<Harness />));
    await act(async () => { void voice.onMicPress(); });
    await act(async () => { vi.advanceTimersByTime(15_000); });

    expect(container.firstElementChild?.getAttribute('data-transcribing')).toBe('true');
    expect(container.firstElementChild?.getAttribute('data-error')).toBe('Transcription timed out.');

    act(() => voice.retryTranscription());
    expect(mocks.streamRetry).toHaveBeenCalledOnce();
    expect(container.firstElementChild?.getAttribute('data-error')).toBe('');

    act(() => mocks.onStreamFinal?.('retried words'));
    await act(async () => { vi.advanceTimersByTime(1_500); });
    expect(onTranscript).toHaveBeenCalledWith('retried words');
    expect(container.firstElementChild?.getAttribute('data-transcribing')).toBe('false');
  });

  it('reuses the batch blob when a timed-out request is retried', async () => {
    mocks.mode = 'batch';
    mocks.recorderState = 'recording';
    const audio = new Blob(['audio']);
    mocks.recorderStop.mockResolvedValue(audio);
    mocks.transcribe
      .mockRejectedValueOnce(new Error('Command timeout'))
      .mockResolvedValueOnce('retried batch words');

    await act(async () => root.render(<Harness />));
    await act(async () => { void voice.onMicPress(); });

    expect(container.firstElementChild?.getAttribute('data-transcribing')).toBe('true');
    expect(container.firstElementChild?.getAttribute('data-error')).toBe('Transcription timed out.');

    await act(async () => { voice.retryTranscription(); });
    expect(mocks.transcribe).toHaveBeenCalledTimes(2);
    expect(mocks.transcribe.mock.calls[1]?.[0]).toBe(audio);
    expect(onTranscript).toHaveBeenCalledWith('retried batch words');
    expect(container.firstElementChild?.getAttribute('data-transcribing')).toBe('false');
  });
});
