// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { VoiceConfig } from '@sumicom/quicksave-shared';
import {
  MICROPHONE_START_TIMEOUT_MS,
  shouldUseLegacyPcmCapture,
  VoiceStreamSession,
} from './voiceStreamClient';

// Shared, hoisted spies so the `./busRegistry` mock factory (hoisted above the
// imports by vitest) can reference them without a TDZ error.
const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const stopTrack = vi.fn();
  const busCommand = vi.fn(async (verb: string) => {
    if (verb === 'voice:rtc-connect') return { sdp: 'answer-sdp' };
    if (verb === 'voice:microphone-claim') {
      calls.push('leaseClaim');
      return { ok: true };
    }
    return {};
  });
  const busSubscribe = vi.fn(() => () => {});
  const getUserMedia = vi.fn(async () => {
    calls.push('gum');
    const track = { kind: 'audio', stop: stopTrack };
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  });
  return { calls, stopTrack, busCommand, busSubscribe, getUserMedia };
});

vi.mock('./busRegistry', () => ({
  getBusForAgent: () => ({ command: mocks.busCommand, subscribe: mocks.busSubscribe }),
}));

// ── Minimal WebRTC / WebAudio fakes (jsdom provides none of these) ───────────

class FakeDataChannel {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  binaryType = '';
  readyState = 'open';
  send = vi.fn();
  close = vi.fn();
  addEventListener = vi.fn();
}

class FakeRTCPeerConnection {
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = 'new';
  ontrack: ((e: { track: MediaStreamTrack; streams: MediaStream[] }) => void) | null = null;
  dc: FakeDataChannel | null = null;
  sender = { replaceTrack: vi.fn(async () => {}) };
  transceiver = { sender: this.sender };
  addTransceiver = vi.fn(() => this.transceiver);
  createDataChannel = vi.fn(() => (this.dc = new FakeDataChannel()));
  createOffer = vi.fn(async () => {
    mocks.calls.push('createOffer');
    return { type: 'offer', sdp: 'offer-sdp' };
  });
  setLocalDescription = vi.fn(async () => {
    mocks.calls.push('setLocalDescription');
  });
  setRemoteDescription = vi.fn(async () => {
    mocks.calls.push('setRemoteDescription');
    // Simulate the channel opening so connect()'s `ready` promise resolves true.
    // Use a real promise microtask (never intercepted by fake timers).
    void Promise.resolve().then(() => this.dc?.onopen?.());
  });
  addIceCandidate = vi.fn(async () => {});
  close = vi.fn();
  addEventListener = vi.fn();
  constructor(public config: unknown) {
    lastPc = this;
  }
}

let lastPc: FakeRTCPeerConnection | null = null;

class FakeAudioContext {
  state: AudioContextState = initialAudioContextState;
  sampleRate = 48_000;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn((n: unknown) => n), disconnect: vi.fn() }));
  createGain = vi.fn(() => {
    lastGainNode = { gain: { value: 0 }, connect: vi.fn((n: unknown) => n), disconnect: vi.fn() };
    return lastGainNode;
  });
  createScriptProcessor = vi.fn(() => {
    lastLegacyNode = new FakeScriptProcessorNode();
    return lastLegacyNode;
  });
  resume = vi.fn(async () => {
    if (resumeError) throw resumeError;
    this.state = 'running';
  });
  close = vi.fn(async () => {});
  constructor() {
    lastAudioContext = this;
  }
}

let initialAudioContextState: AudioContextState = 'running';
let resumeError: Error | null = null;
let lastAudioContext: FakeAudioContext | null = null;
let lastGainNode: { gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } | null = null;

class FakeScriptProcessorNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;
  connect = vi.fn((node: unknown) => node);
  disconnect = vi.fn();
}

let lastLegacyNode: FakeScriptProcessorNode | null = null;

class FakeAudioWorkletNode {
  port: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
  onprocessorerror: (() => void) | null = null;
  connect = vi.fn((n: unknown) => n);
  disconnect = vi.fn();
  constructor(
    public ctx: unknown,
    public name: string,
    public opts: unknown,
  ) {
    lastWorkletNode = this;
  }
}

let lastWorkletNode: FakeAudioWorkletNode | null = null;

const CONFIG: VoiceConfig = {
  apiKey: '',
  baseUrl: '',
  mode: 'streaming',
  transcribeModel: '',
  streamModel: '',
};

function makeSession(voiceSessionId?: string, onDebug?: (event: { detail: string; data?: Record<string, unknown> }) => void) {
  const states: string[] = [];
  const speech: boolean[] = [];
  const playback: Array<{ active: boolean; streamId: string }> = [];
  const audioFrames: ArrayBuffer[] = [];
  const session = new VoiceStreamSession('agent1', 'sess1', CONFIG, {
    onPartial: () => {},
    onFinal: () => {},
    onAudioFrame: (pcm) => audioFrames.push(pcm),
    onSpeechActivity: (active) => speech.push(active),
    onRemotePlayback: (active, streamId) => playback.push({ active, streamId }),
    onError: () => {},
    onState: (s) => states.push(s),
  }, onDebug, voiceSessionId);
  return { session, states, speech, playback, audioFrames };
}

async function startWithFirstFrame(session: VoiceStreamSession): Promise<void> {
  const starting = session.startUtterance();
  for (let i = 0; i < 10 && !lastPc?.dc?.send.mock.calls.some(([value]) =>
    value === JSON.stringify({ t: 'microphone-claim' })); i++) await Promise.resolve();
  lastPc?.dc?.onmessage?.({
    data: JSON.stringify({ t: 'microphone-claim-result', granted: true }),
  });
  for (let i = 0; i < 10 && !lastWorkletNode; i++) await Promise.resolve();
  expect(lastWorkletNode).not.toBeNull();
  lastWorkletNode?.port.onmessage?.({ data: new Int16Array([1]).buffer });
  await starting;
}

beforeEach(() => {
  // Park the lib's 8s connect-timeout on a fake clock so it never dangles.
  vi.useFakeTimers();
  mocks.calls.length = 0;
  mocks.busCommand.mockClear();
  mocks.busSubscribe.mockClear();
  mocks.getUserMedia.mockClear();
  mocks.stopTrack.mockClear();
  lastPc = null;
  lastWorkletNode = null;
  lastAudioContext = null;
  lastGainNode = null;
  lastLegacyNode = null;
  initialAudioContextState = 'running';
  resumeError = null;
  mocks.getUserMedia.mockImplementation(async () => {
    mocks.calls.push('gum');
    const track = { kind: 'audio', stop: mocks.stopTrack };
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  });

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: mocks.getUserMedia },
  });
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    configurable: true,
    value: 'test-browser',
  });
  vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:fake'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('VoiceStreamSession.connect', () => {
  it('acquires the mic BEFORE creating the offer on the gesture path', async () => {
    const { session } = makeSession();

    const ok = await session.connect({ acquireMic: true });

    expect(ok).toBe(true);
    expect(mocks.getUserMedia).toHaveBeenCalledTimes(1);
    // The Safari ICE gate fix hinges on this ordering.
    expect(mocks.calls.indexOf('gum')).toBeGreaterThanOrEqual(0);
    expect(mocks.calls.indexOf('gum')).toBeLessThan(mocks.calls.indexOf('createOffer'));
  });

  it('does NOT touch the mic on the passive prewarm path', async () => {
    const { session } = makeSession();

    const ok = await session.connect();

    expect(ok).toBe(true);
    expect(mocks.getUserMedia).not.toHaveBeenCalled();
    expect(mocks.calls).not.toContain('gum');
    expect(mocks.calls).toContain('createOffer');
  });

  it('does not let the stale connect timeout reset an active recording', async () => {
    const { session, states } = makeSession();

    expect(await session.connect()).toBe(true);
    await startWithFirstFrame(session);
    expect(session.getState()).toBe('recording');

    await vi.advanceTimersByTimeAsync(8_000);

    expect(session.getState()).toBe('recording');
    expect(states).not.toContain('unavailable');
  });

  it('claims the session lease before getUserMedia on a voice coworker gesture', async () => {
    const { session } = makeSession('coding-session');

    const ok = await session.connect({ acquireMic: true });

    expect(ok).toBe(true);
    const claimIndex = mocks.busCommand.mock.calls.findIndex(([verb]) => verb === 'voice:microphone-claim');
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.calls.indexOf('gum')).toBeGreaterThanOrEqual(0);
    expect(mocks.calls.indexOf('leaseClaim')).toBeLessThan(mocks.calls.indexOf('gum'));
    expect(mocks.busCommand.mock.calls[claimIndex]?.[1]).toEqual({
      sessionId: 'sess1',
      voiceSessionId: 'coding-session',
    });
  });

  it('reports unavailable and never builds an offer when mic permission is denied', async () => {
    mocks.getUserMedia.mockImplementationOnce(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const { session, states } = makeSession();

    const ok = await session.connect({ acquireMic: true });

    expect(ok).toBe(false);
    expect(states).toContain('unavailable');
    expect(mocks.calls).not.toContain('createOffer');
  });

  it('times out a pending permission request and stops a stream that arrives late', async () => {
    let resolveMicrophone!: (stream: MediaStream) => void;
    const lateStop = vi.fn();
    const preparedMicrophone = new Promise<MediaStream>((resolve) => { resolveMicrophone = resolve; });
    const { session, states } = makeSession();

    const connecting = session.connect({ acquireMic: true, preparedMicrophone });
    await vi.advanceTimersByTimeAsync(MICROPHONE_START_TIMEOUT_MS);

    await expect(connecting).resolves.toBe(false);
    expect(states).toContain('unavailable');
    resolveMicrophone({ getTracks: () => [{ stop: lateStop }] } as unknown as MediaStream);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateStop).toHaveBeenCalledOnce();
  });
});

describe('VoiceStreamSession.startUtterance', () => {
  it('rejects a stale ready state when the DataChannel is no longer open', async () => {
    const { session, states } = makeSession();
    await session.connect();
    expect(session.isReadyForCapture()).toBe(true);
    if (lastPc?.dc) lastPc.dc.readyState = 'closed';
    mocks.getUserMedia.mockClear();

    await expect(session.startUtterance()).rejects.toThrow('no longer ready');

    expect(session.isReadyForCapture()).toBe(false);
    expect(mocks.getUserMedia).not.toHaveBeenCalled();
    expect(states).not.toContain('recording');
  });

  it('uses the ScriptProcessor PCM fallback in Firefox', async () => {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 Firefox/145.0',
    });
    expect(shouldUseLegacyPcmCapture(navigator.userAgent)).toBe(true);
    const { session, states } = makeSession();
    await session.connect();

    const starting = session.startUtterance();
    for (let i = 0; i < 50 && !lastLegacyNode; i++) await Promise.resolve();
    expect(lastLegacyNode).not.toBeNull();
    expect(lastWorkletNode).toBeNull();
    const input = new Float32Array(2048).fill(0.25);
    const output = new Float32Array(2048).fill(1);
    lastLegacyNode?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => input },
      outputBuffer: { getChannelData: () => output },
    } as AudioProcessingEvent);
    await starting;

    expect(output.every((sample) => sample === 0)).toBe(true);
    expect(lastPc?.dc?.send).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    expect(states).toContain('recording');
  });

  it('uses the ScriptProcessor PCM fallback in an iOS Home Screen PWA', async () => {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    });
    expect(shouldUseLegacyPcmCapture(navigator.userAgent)).toBe(true);
    const { session, states } = makeSession();
    await session.connect();

    const starting = session.startUtterance();
    for (let i = 0; i < 50 && !lastLegacyNode; i++) await Promise.resolve();
    expect(lastLegacyNode).not.toBeNull();
    expect(lastWorkletNode).toBeNull();
    const input = new Float32Array(2048).fill(0.2);
    const output = new Float32Array(2048).fill(1);
    lastLegacyNode?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => input },
      outputBuffer: { getChannelData: () => output },
    } as AudioProcessingEvent);
    await starting;

    expect(output.every((sample) => sample === 0)).toBe(true);
    expect(lastPc?.dc?.send).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    expect(states).toContain('recording');
  });

  it('recognizes the desktop-style iPad user agent', () => {
    expect(shouldUseLegacyPcmCapture(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Mobile/15E148',
      5,
    )).toBe(true);
    expect(shouldUseLegacyPcmCapture(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Safari/605.1.15',
      0,
    )).toBe(false);
  });

  it('does not open the microphone until the session lease is granted', async () => {
    const { session } = makeSession('coding-session');
    await session.connect();

    const starting = session.startUtterance();
    await Promise.resolve();
    expect(mocks.getUserMedia).not.toHaveBeenCalled();

    lastPc?.dc?.onmessage?.({
      data: JSON.stringify({ t: 'microphone-claim-result', granted: true }),
    });
    for (let i = 0; i < 50 && !lastWorkletNode; i++) await Promise.resolve();
    expect(lastWorkletNode).not.toBeNull();
    lastWorkletNode?.port.onmessage?.({ data: new Int16Array([1]).buffer });
    await starting;
    expect(mocks.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent auto-listen starts into one lease and capture attempt', async () => {
    const { session } = makeSession('coding-session');
    await session.connect();

    const first = session.startUtterance();
    const second = session.startUtterance();
    expect(second).toBe(first);
    for (let i = 0; i < 50 && !lastWorkletNode; i++) await Promise.resolve();
    expect(lastWorkletNode).not.toBeNull();
    lastWorkletNode?.port.onmessage?.({ data: new Int16Array([1]).buffer });
    await Promise.all([first, second]);

    expect(mocks.busCommand.mock.calls.filter(([verb]) => verb === 'voice:microphone-claim')).toHaveLength(1);
    expect(mocks.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('keeps playback connected but does not capture when another page owns the microphone', async () => {
    const { session, states } = makeSession('coding-session');
    await session.connect();
    mocks.busCommand.mockImplementationOnce(async () => ({
      ok: false,
      error: 'Microphone is active on another voice page.',
    }));

    const starting = session.startUtterance();

    await expect(starting).rejects.toThrow('another voice page');
    expect(mocks.getUserMedia).not.toHaveBeenCalled();
    expect(states).not.toContain('recording');
  });

  it('reuses the connect-time stream instead of re-prompting', async () => {
    const { session } = makeSession();
    await session.connect({ acquireMic: true });

    await startWithFirstFrame(session);

    // One acquisition total: the connect-time grab, reused for the utterance.
    expect(mocks.getUserMedia).toHaveBeenCalledTimes(1);
    expect(lastPc?.addTransceiver).toHaveBeenCalledWith('audio', { direction: 'recvonly' });
    expect(lastPc?.sender.replaceTrack).not.toHaveBeenCalled();
  });

  it('acquires generic Record voice directly without a voice-coworker lease', async () => {
    const { session } = makeSession();
    await session.connect();
    expect(mocks.getUserMedia).not.toHaveBeenCalled();

    await startWithFirstFrame(session);

    expect(mocks.getUserMedia).toHaveBeenCalledTimes(1);
    expect(mocks.busCommand.mock.calls.some(([verb]) => verb === 'voice:microphone-claim')).toBe(false);
  });

  it('can stop an utterance without releasing the mic stream for continuous listening', async () => {
    const { session } = makeSession();
    await session.connect({ acquireMic: true });
    await startWithFirstFrame(session);

    session.stopUtterance({ releaseMic: false });

    expect(mocks.stopTrack).not.toHaveBeenCalled();

    session.close();
    expect(mocks.stopTrack).toHaveBeenCalledTimes(1);
  });

  it('sends AudioWorklet PCM over the DataChannel and declares that ingress transport', async () => {
    const { session, audioFrames } = makeSession();
    await session.connect({ acquireMic: true });
    lastPc?.dc?.send.mockClear();
    await startWithFirstFrame(session);

    const pcm = new Int16Array([100, -100]).buffer;
    lastWorkletNode?.port.onmessage?.({ data: pcm });

    expect(lastPc?.dc?.send).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    expect(lastPc?.dc?.send).toHaveBeenCalledWith(JSON.stringify({
      t: 'start',
      config: CONFIG,
      sampleRate: 24_000,
      audioTransport: 'datachannel',
    }));
    expect(lastWorkletNode?.opts).toEqual(expect.objectContaining({
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    }));
    expect(lastGainNode?.gain.value).toBe(1);
    expect(audioFrames).toHaveLength(2);
    // The recovery callback owns a separate copy, so capture survives callers
    // that later transfer or otherwise detach their outgoing frame.
    expect(audioFrames[1]).not.toBe(pcm);
  });

  it('replays retained PCM frames in order without reopening the microphone', async () => {
    const { session } = makeSession();
    await session.connect();
    lastPc?.dc?.send.mockClear();
    const first = new Int16Array([1, 2]).buffer;
    const second = new Int16Array([3, 4]).buffer;

    expect(session.replayUtterance([first, second])).toBe(true);
    expect(lastPc?.dc?.send.mock.calls.map(([value]) => value)).toEqual([
      JSON.stringify({ t: 'start', config: CONFIG, sampleRate: 24_000, audioTransport: 'datachannel' }),
      first,
      second,
      JSON.stringify({ t: 'stop', releaseMicrophone: true }),
    ]);
    expect(mocks.getUserMedia).not.toHaveBeenCalled();
  });

  it('resumes a suspended AudioContext before accepting the first PCM frame', async () => {
    initialAudioContextState = 'suspended';
    const { session, states } = makeSession();
    await session.connect({ acquireMic: true });

    await startWithFirstFrame(session);

    expect(lastAudioContext?.resume).toHaveBeenCalledTimes(1);
    expect(lastAudioContext?.state).toBe('running');
    expect(states).toContain('recording');
  });

  it('does not report recording when AudioContext resume fails', async () => {
    initialAudioContextState = 'suspended';
    resumeError = new DOMException('blocked', 'NotAllowedError');
    const { session, states } = makeSession();
    await session.connect({ acquireMic: true });

    const starting = session.startUtterance();
    await Promise.resolve();
    lastPc?.dc?.onmessage?.({
      data: JSON.stringify({ t: 'microphone-claim-result', granted: true }),
    });
    await expect(starting).rejects.toThrow('Could not start microphone capture');

    expect(states).not.toContain('recording');
    expect(mocks.stopTrack).toHaveBeenCalledTimes(1);
  });

  it('times out and cleans up when the worklet produces no PCM frames', async () => {
    const debugEvents: Array<{ detail: string; data?: Record<string, unknown> }> = [];
    const { session, states } = makeSession(undefined, (event) => debugEvents.push(event));
    await session.connect({ acquireMic: true });

    const starting = session.startUtterance();
    const rejected = expect(starting).rejects.toThrow('produced no audio frames');
    await Promise.resolve();
    lastPc?.dc?.onmessage?.({
      data: JSON.stringify({ t: 'microphone-claim-result', granted: true }),
    });
    for (let i = 0; i < 10 && !lastWorkletNode; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_500);

    await rejected;
    expect(states).not.toContain('recording');
    expect(mocks.stopTrack).toHaveBeenCalledTimes(1);
    expect(lastAudioContext?.close).toHaveBeenCalledTimes(1);
    expect(debugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detail: 'capture processor selected',
        data: expect.objectContaining({ processor: 'AudioWorklet' }),
      }),
      expect.objectContaining({
        detail: 'first PCM frame timed out',
        data: expect.objectContaining({
          timeoutMs: 2_500,
          frameCount: 0,
          contextState: 'running',
          sampleRate: 48_000,
          dataChannelState: 'open',
        }),
      }),
      expect.objectContaining({ detail: 'capture teardown' }),
      expect.objectContaining({ detail: 'microphone capture failed to start' }),
    ]));
  });

  it('fails promptly and cleans up when Firefox reports a worklet processor error', async () => {
    const { session, states } = makeSession();
    await session.connect({ acquireMic: true });

    const starting = session.startUtterance();
    await Promise.resolve();
    lastPc?.dc?.onmessage?.({
      data: JSON.stringify({ t: 'microphone-claim-result', granted: true }),
    });
    for (let i = 0; i < 10 && !lastWorkletNode; i++) await Promise.resolve();
    lastWorkletNode?.onprocessorerror?.();

    await expect(starting).rejects.toThrow('AudioWorklet processor failed');
    expect(states).not.toContain('recording');
    expect(mocks.stopTrack).toHaveBeenCalledTimes(1);
  });
});

describe('VoiceStreamSession DataChannel messages', () => {
  it('routes speech activity messages to the callback', async () => {
    const { session, speech } = makeSession();
    await session.connect();

    lastPc?.dc?.onmessage?.({ data: JSON.stringify({ t: 'speech', active: true }) });
    lastPc?.dc?.onmessage?.({ data: JSON.stringify({ t: 'speech', active: false }) });

    expect(speech).toEqual([true, false]);
  });

  it('routes remote playback lifecycle messages to the callback', async () => {
    const { session, playback } = makeSession();
    await session.connect();
    lastPc?.ontrack?.({
      track: { kind: 'audio', enabled: false } as MediaStreamTrack,
      streams: [{} as MediaStream],
    });

    lastPc?.dc?.onmessage?.({ data: JSON.stringify({ t: 'playback', active: true, streamId: 'tts-1' }) });
    await vi.advanceTimersByTimeAsync(0);
    lastPc?.dc?.onmessage?.({ data: JSON.stringify({ t: 'playback', active: false, streamId: 'tts-1' }) });

    expect(playback).toEqual([
      { active: true, streamId: 'tts-1' },
      { active: false, streamId: 'tts-1' },
    ]);
    session.close();
  });

  it('mounts the remote audio element and reports playback only after play() succeeds', async () => {
    const { session, playback } = makeSession();
    await session.connect();
    const track = { kind: 'audio', enabled: false } as MediaStreamTrack;
    const stream = {} as MediaStream;
    lastPc?.ontrack?.({ track, streams: [stream] });

    expect(document.body.querySelector('audio[aria-hidden="true"]')).toBeNull();

    lastPc?.dc?.onmessage?.({ data: JSON.stringify({ t: 'playback', active: true, streamId: 'tts-dom' }) });
    await vi.advanceTimersByTimeAsync(0);

    expect(track.enabled).toBe(true);
    expect(document.body.querySelector('audio[aria-hidden="true"]')).not.toBeNull();
    expect(playback).toContainEqual({ active: true, streamId: 'tts-dom' });

    lastPc?.dc?.onmessage?.({ data: JSON.stringify({ t: 'playback', active: false, streamId: 'tts-dom' }) });
    expect(document.body.querySelector('audio[aria-hidden="true"]')).toBeNull();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();

    session.close();
    expect(document.body.querySelector('audio[aria-hidden="true"]')).toBeNull();
  });

  it('sends a control message when confirmed barge-in stops remote playback', async () => {
    const { session } = makeSession();
    await session.connect();
    lastPc?.dc?.send.mockClear();

    session.interruptPlayback();

    expect(lastPc?.dc?.send).toHaveBeenCalledWith(JSON.stringify({ t: 'interrupt-playback' }));
  });

  it('requests transcription retry over the existing DataChannel', async () => {
    const { session } = makeSession();
    await session.connect();
    lastPc?.dc?.send.mockClear();

    session.retryTranscription();

    expect(lastPc?.dc?.send).toHaveBeenCalledWith(JSON.stringify({ t: 'retry-transcription' }));
  });
});
