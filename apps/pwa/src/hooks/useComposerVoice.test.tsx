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
  recorderStart: vi.fn(),
  recorderCancel: vi.fn(),
  streamRecording: false,
  streamStart: vi.fn(),
  streamStop: vi.fn(),
  streamRetry: vi.fn(),
  getVoiceConfig: vi.fn(),
  onStreamFinal: null as ((text: string) => void) | null,
  voiceStreamOptions: undefined as unknown,
  transcribe: vi.fn(),
  logVoiceEvent: vi.fn(),
}));

vi.mock('../stores/connectionStore', () => ({
  useConnectionStore: (selector: (state: unknown) => unknown) => selector({
    agentConnections: { agent: { audio: { streaming: true, transcription: true } } },
  }),
}));
vi.mock('../lib/secureStorage', () => ({
  getVoiceConfig: (...args: unknown[]) => mocks.getVoiceConfig(...args),
}));
vi.mock('../stores/localeStore', () => ({
  useLocaleStore: (selector: (state: unknown) => unknown) => selector({ active: 'zh-TW' }),
}));
vi.mock('../lib/voiceTranscription', () => ({
  isVoiceConfigUsable: () => true,
  transcribeViaAgent: (...args: unknown[]) => mocks.transcribe(...args),
}));
vi.mock('../lib/voiceAgentClient', () => ({
  logVoiceEvent: (...args: unknown[]) => mocks.logVoiceEvent(...args),
}));
vi.mock('./useVoiceRecorder', () => ({
  useVoiceRecorder: () => ({
    state: mocks.recorderState,
    start: mocks.recorderStart,
    stop: mocks.recorderStop,
    cancel: mocks.recorderCancel,
  }),
}));
vi.mock('./useVoiceStream', () => ({
  useVoiceStream: (
    _agentId: string,
    onFinal: (text: string) => void,
    _onSpeech?: unknown,
    _onPartial?: unknown,
    _onFrame?: unknown,
    _onPlayback?: unknown,
    options?: unknown,
  ) => {
    mocks.onStreamFinal = onFinal;
    mocks.voiceStreamOptions = options;
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
      replayTranscription: vi.fn(async () => true),
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
    mocks.voiceStreamOptions = undefined;
    mocks.recorderStop.mockReset();
    mocks.recorderStart.mockReset().mockResolvedValue(true);
    mocks.recorderCancel.mockReset();
    mocks.streamStop.mockReset();
    mocks.streamRetry.mockReset();
    mocks.streamStart.mockReset().mockResolvedValue(true);
    mocks.getVoiceConfig.mockReset().mockImplementation(async () => ({ mode: mocks.mode }));
    mocks.transcribe.mockReset();
    mocks.logVoiceEvent.mockReset();
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

  it('starts the streaming gesture before an IndexedDB config read settles', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => { await Promise.resolve(); });

    let resolveConfig!: (config: { mode: 'streaming' }) => void;
    mocks.getVoiceConfig.mockReturnValueOnce(new Promise((resolve) => { resolveConfig = resolve; }));

    act(() => { void voice.onMicPress(); });
    expect(mocks.streamStart).toHaveBeenCalledOnce();
    expect(container.firstElementChild?.getAttribute('data-arming')).toBe('true');

    await act(async () => { resolveConfig({ mode: 'streaming' }); });
    expect(container.firstElementChild?.getAttribute('data-arming')).toBe('false');

    const lifecycleEvents = mocks.logVoiceEvent.mock.calls
      .map(([, event]) => event as { event: string; data?: Record<string, unknown> })
      .filter((event) => event.event.startsWith('capture.attempt_'));
    expect(lifecycleEvents.map((event) => event.event)).toEqual([
      'capture.attempt_started',
      'capture.attempt_recording',
    ]);
    expect(lifecycleEvents[0]?.data?.captureAttemptId).toEqual(expect.any(String));
    expect(lifecycleEvents[1]?.data?.captureAttemptId).toBe(lifecycleEvents[0]?.data?.captureAttemptId);
  });

  it('starts batch getUserMedia before an IndexedDB config read settles', async () => {
    mocks.mode = 'batch';
    await act(async () => root.render(<Harness />));
    await act(async () => { await Promise.resolve(); });

    let resolveConfig!: (config: { mode: 'batch' }) => void;
    mocks.getVoiceConfig.mockReturnValueOnce(new Promise((resolve) => { resolveConfig = resolve; }));

    act(() => { void voice.onMicPress(); });
    expect(mocks.recorderStart).toHaveBeenCalledOnce();
    expect(container.firstElementChild?.getAttribute('data-arming')).toBe('true');

    await act(async () => { resolveConfig({ mode: 'batch' }); });
    expect(container.firstElementChild?.getAttribute('data-arming')).toBe('false');
  });

  it('returns batch capture to idle when microphone startup fails', async () => {
    mocks.mode = 'batch';
    mocks.recorderStart.mockResolvedValue(false);
    await act(async () => root.render(<Harness />));

    let started = true;
    await act(async () => { started = await voice.startListening(); });

    expect(started).toBe(false);
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
    expect(mocks.transcribe.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      transcriptionLocale: 'zh-TW',
    }));
    expect(container.firstElementChild?.getAttribute('data-transcribing')).toBe('false');
  });

  it('passes the active Traditional Chinese locale to streaming ASR', async () => {
    await act(async () => root.render(<Harness />));
    expect(mocks.voiceStreamOptions).toEqual(expect.objectContaining({
      transcriptionLocale: 'zh-TW',
    }));
  });

  it('persists capture diagnostics without private ICE candidate addresses', async () => {
    await act(async () => root.render(<Harness />));
    const onDebug = (mocks.voiceStreamOptions as {
      onDebug?: (event: { t: number; kind: 'local-candidate'; detail: string; data: Record<string, unknown> }) => void;
    }).onDebug;

    act(() => onDebug?.({
      t: 42,
      kind: 'local-candidate',
      detail: 'host',
      data: { type: 'host', candidate: 'candidate with private address' },
    }));

    expect(mocks.logVoiceEvent).toHaveBeenCalledWith('agent', expect.objectContaining({
      event: 'capture.local-candidate',
      phase: 'capture',
      data: expect.objectContaining({ elapsedMs: 42, detail: 'host', type: 'host' }),
    }));
    const payload = mocks.logVoiceEvent.mock.calls.at(-1)?.[1] as { data?: Record<string, unknown> };
    expect(payload.data).not.toHaveProperty('candidate');
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
