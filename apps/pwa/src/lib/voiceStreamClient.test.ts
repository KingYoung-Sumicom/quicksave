// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { VoiceConfig } from '@sumicom/quicksave-shared';
import { VoiceStreamSession } from './voiceStreamClient';

// Shared, hoisted spies so the `./busRegistry` mock factory (hoisted above the
// imports by vitest) can reference them without a TDZ error.
const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const stopTrack = vi.fn();
  const busCommand = vi.fn(async (verb: string) =>
    verb === 'voice:rtc-connect' ? { sdp: 'answer-sdp' } : {},
  );
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
  constructor(public config: unknown) {
    lastPc = this;
  }
}

let lastPc: FakeRTCPeerConnection | null = null;

class FakeAudioContext {
  state: AudioContextState = initialAudioContextState;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn((n: unknown) => n), disconnect: vi.fn() }));
  createGain = vi.fn(() => ({ gain: { value: 0 }, connect: vi.fn((n: unknown) => n), disconnect: vi.fn() }));
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

class FakeAudioWorkletNode {
  port: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
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

function makeSession() {
  const states: string[] = [];
  const speech: boolean[] = [];
  const playback: Array<{ active: boolean; streamId: string }> = [];
  const session = new VoiceStreamSession('agent1', 'sess1', CONFIG, {
    onPartial: () => {},
    onFinal: () => {},
    onSpeechActivity: (active) => speech.push(active),
    onRemotePlayback: (active, streamId) => playback.push({ active, streamId }),
    onError: () => {},
    onState: (s) => states.push(s),
  });
  return { session, states, speech, playback };
}

async function startWithFirstFrame(session: VoiceStreamSession): Promise<void> {
  const starting = session.startUtterance();
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
});

describe('VoiceStreamSession.startUtterance', () => {
  it('reuses the connect-time stream instead of re-prompting', async () => {
    const { session } = makeSession();
    await session.connect({ acquireMic: true });

    await startWithFirstFrame(session);

    // One acquisition total: the connect-time grab, reused for the utterance.
    expect(mocks.getUserMedia).toHaveBeenCalledTimes(1);
    expect(lastPc?.addTransceiver).toHaveBeenCalledWith('audio', { direction: 'recvonly' });
    expect(lastPc?.sender.replaceTrack).not.toHaveBeenCalled();
  });

  it('acquires the mic lazily when connect() did not (prewarm path)', async () => {
    const { session } = makeSession();
    await session.connect();
    expect(mocks.getUserMedia).not.toHaveBeenCalled();

    await startWithFirstFrame(session);

    expect(mocks.getUserMedia).toHaveBeenCalledTimes(1);
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
    const { session } = makeSession();
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

    await expect(session.startUtterance()).rejects.toThrow('Could not start microphone capture');

    expect(states).not.toContain('recording');
    expect(mocks.stopTrack).toHaveBeenCalledTimes(1);
  });

  it('times out and cleans up when the worklet produces no PCM frames', async () => {
    const { session, states } = makeSession();
    await session.connect({ acquireMic: true });

    const starting = session.startUtterance();
    const rejected = expect(starting).rejects.toThrow('produced no audio frames');
    for (let i = 0; i < 10 && !lastWorkletNode; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    await rejected;
    expect(states).not.toContain('recording');
    expect(mocks.stopTrack).toHaveBeenCalledTimes(1);
    expect(lastAudioContext?.close).toHaveBeenCalledTimes(1);
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
});
