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
    return { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
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
  dc: FakeDataChannel | null = null;
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
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn((n: unknown) => n) }));
  createGain = vi.fn(() => ({ gain: { value: 0 }, connect: vi.fn((n: unknown) => n) }));
  close = vi.fn(async () => {});
}

class FakeAudioWorkletNode {
  port: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
  connect = vi.fn((n: unknown) => n);
  constructor(
    public ctx: unknown,
    public name: string,
    public opts: unknown,
  ) {}
}

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
  const session = new VoiceStreamSession('agent1', 'sess1', CONFIG, {
    onPartial: () => {},
    onFinal: () => {},
    onSpeechActivity: (active) => speech.push(active),
    onError: () => {},
    onState: (s) => states.push(s),
  });
  return { session, states, speech };
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
  mocks.getUserMedia.mockImplementation(async () => {
    mocks.calls.push('gum');
    return { getTracks: () => [{ stop: mocks.stopTrack }] } as unknown as MediaStream;
  });

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: mocks.getUserMedia },
  });
  vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:fake'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
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

    await session.startUtterance();

    // One acquisition total: the connect-time grab, reused for the utterance.
    expect(mocks.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('acquires the mic lazily when connect() did not (prewarm path)', async () => {
    const { session } = makeSession();
    await session.connect();
    expect(mocks.getUserMedia).not.toHaveBeenCalled();

    await session.startUtterance();

    expect(mocks.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('can stop an utterance without releasing the mic stream for continuous listening', async () => {
    const { session } = makeSession();
    await session.connect({ acquireMic: true });
    await session.startUtterance();

    session.stopUtterance({ releaseMic: false });

    expect(mocks.stopTrack).not.toHaveBeenCalled();

    session.close();
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
});
