// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { classifyVoiceDcData, wireVoiceStream, type VoiceBus } from './voiceStream.js';

describe('classifyVoiceDcData', () => {
  it('parses a JSON control message', () => {
    const r = classifyVoiceDcData(JSON.stringify({ t: 'stop' }));
    expect(r.kind).toBe('control');
    if (r.kind === 'control') expect(r.msg.t).toBe('stop');
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
    expect(commands).toEqual(expect.arrayContaining(['voice:rtc-connect', 'voice:rtc-ice']));
  });
});
