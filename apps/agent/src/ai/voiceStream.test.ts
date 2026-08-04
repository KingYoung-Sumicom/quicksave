// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { canStartVoiceCapture, classifyVoiceDcData, MicrophoneLeaseRegistry, offerNegotiatesAudio, resamplePcm16, wireVoiceStream, type VoiceBus } from './voiceStream.js';

describe('classifyVoiceDcData', () => {
  it('parses a JSON control message', () => {
    const r = classifyVoiceDcData(JSON.stringify({ t: 'stop' }));
    expect(r.kind).toBe('control');
    if (r.kind === 'control') expect(r.msg.t).toBe('stop');
  });

  it('preserves the discard flag on a stop control message', () => {
    const r = classifyVoiceDcData(JSON.stringify({ t: 'stop', discard: true }));
    expect(r.kind).toBe('control');
    if (r.kind === 'control' && r.msg.t === 'stop') expect(r.msg.discard).toBe(true);
  });

  it('parses a retry-transcription control message', () => {
    const r = classifyVoiceDcData(JSON.stringify({ t: 'retry-transcription' }));
    expect(r.kind).toBe('control');
    if (r.kind === 'control') expect(r.msg.t).toBe('retry-transcription');
  });

  it('treats a non-control / malformed JSON string as ignore', () => {
    expect(classifyVoiceDcData('not json').kind).toBe('ignore');
    expect(classifyVoiceDcData(JSON.stringify({ noT: 1 })).kind).toBe('ignore');
  });

  it('treats an ArrayBuffer as audio bytes', () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    const r = classifyVoiceDcData(buf);
    expect(r.kind).toBe('audio');
    if (r.kind === 'audio') expect([...r.bytes]).toEqual([1, 2, 3, 4]);
  });

  it('treats a typed-array view as audio, respecting offset/length', () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    const view = new Uint8Array(backing.buffer, 1, 3); // [1,2,3]
    const r = classifyVoiceDcData(view);
    expect(r.kind).toBe('audio');
    if (r.kind === 'audio') expect([...r.bytes]).toEqual([1, 2, 3]);
  });

  it('treats a Buffer as audio', () => {
    const r = classifyVoiceDcData(Buffer.from([5, 6]));
    expect(r.kind).toBe('audio');
    if (r.kind === 'audio') expect([...r.bytes]).toEqual([5, 6]);
  });

  it('ignores unknown payload types', () => {
    expect(classifyVoiceDcData(42).kind).toBe('ignore');
    expect(classifyVoiceDcData(null).kind).toBe('ignore');
  });
});

describe('WebRTC PCM conversion', () => {
  it('downsamples interleaved stereo PCM to 24 kHz mono', () => {
    const input = new Int16Array([
      100, 300,
      200, 400,
      300, 500,
      400, 600,
    ]);
    expect([...resamplePcm16(input, 48_000, 24_000, 2)]).toEqual([200, 400]);
  });
});

describe('WebRTC audio negotiation', () => {
  it('distinguishes full-duplex offers from legacy DataChannel-only offers', () => {
    expect(offerNegotiatesAudio('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n')).toBe(true);
    expect(offerNegotiatesAudio('v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n')).toBe(false);
  });
});

describe('MicrophoneLeaseRegistry', () => {
  it('allows exactly one transport to own a session microphone', () => {
    const leases = new MicrophoneLeaseRegistry();
    expect(leases.claim('voice-1', 'page-a')).toBe(true);
    expect(leases.claim('voice-1', 'page-b')).toBe(false);
    expect(leases.release('voice-1', 'page-b')).toBe(false);
    expect(leases.release('voice-1', 'page-a')).toBe(true);
    expect(leases.claim('voice-1', 'page-b')).toBe(true);
  });

  it('does not require the voice-coworker lease for generic Record voice peers', () => {
    expect(canStartVoiceCapture(false, false)).toBe(true);
    expect(canStartVoiceCapture(true, false)).toBe(false);
    expect(canStartVoiceCapture(true, true)).toBe(true);
  });
});

describe('wireVoiceStream', () => {
  it('registers the /voice/rtc/:sessionId push path so trickled ICE can reach the PWA', () => {
    const subscribed: string[] = [];
    const commands: string[] = [];
    const bus: VoiceBus = {
      onCommand: (verb) => { commands.push(verb); },
      onSubscribe: (pattern) => { subscribed.push(pattern); },
      publish: () => {},
    };

    wireVoiceStream(bus);

    // Without this registration the server rejects the PWA's subscription and
    // the agent's candidates publish to zero peers — the P2P-timeout bug.
    expect(subscribed).toContain('/voice/rtc/:sessionId');
    expect(commands).toEqual(expect.arrayContaining([
      'voice:rtc-connect',
      'voice:rtc-ice',
      'voice:microphone-claim',
      'voice:microphone-release',
    ]));
  });
});
