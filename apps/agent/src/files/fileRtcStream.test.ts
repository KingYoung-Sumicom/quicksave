// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRtcBus } from './fileRtcStream.js';

let latestPc: FakePeerConnection | null = null;

class FakePeerConnection {
  onicecandidate: ((event: { candidate: unknown | null }) => void) | null = null;
  ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack = null;
  connectionState = 'connected';
  setRemoteDescription = vi.fn(async () => {});
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer-sdp' }));
  setLocalDescription = vi.fn(async () => {});
  addIceCandidate = vi.fn(async () => {});
  addTrack = vi.fn();
  close = vi.fn();
  constructor(_config: unknown) { latestPc = this; }
}

class FakeDataChannel {
  onmessage = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 'open';
  bufferedAmount = 0;
  sent: Array<string | Uint8Array> = [];
  send = vi.fn((data: string | Uint8Array) => this.sent.push(data));
  close = vi.fn();
}

vi.mock('../ai/voiceStream.js', () => ({
  iceServers: () => [],
  loadWrtc: async () => ({ RTCPeerConnection: FakePeerConnection }),
}));

const { FileRtcStreamManager, wireFileRtcStream } = await import('./fileRtcStream.js');

describe('wireFileRtcStream', () => {
  it('registers signaling commands and the ICE subscription path', () => {
    const commands: string[] = [];
    const subscriptions: string[] = [];
    const bus: FileRtcBus = {
      onCommand: (verb) => { commands.push(verb); },
      onSubscribe: (pattern) => { subscriptions.push(pattern); },
      publish: () => {},
    };
    wireFileRtcStream(bus);
    expect(subscriptions).toContain('/files/rtc/:transferId');
    expect(commands).toEqual(['files:rtc-connect', 'files:rtc-ice', 'files:rtc-cancel']);
  });
});

describe('FileRtcStreamManager', () => {
  let dir: string;
  beforeEach(async () => {
    latestPc = null;
    dir = await mkdtemp(join(tmpdir(), 'quicksave-file-rtc-'));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('streams text as binary chunks followed by a checksum', async () => {
    const body = 'large preview\n'.repeat(10_000);
    await writeFile(join(dir, 'large.txt'), body);
    const bus: FileRtcBus = { onCommand: () => {}, onSubscribe: () => {}, publish: () => {} };
    const manager = new FileRtcStreamManager(bus);

    const answer = await manager.connect({
      transferId: 'transfer-1', cwd: dir, path: 'large.txt', sdp: 'offer', allowImage: true,
    }, 'peer-a');
    expect(answer).toEqual({ sdp: 'answer-sdp' });

    const channel = new FakeDataChannel();
    latestPc?.ondatachannel?.({ channel });
    await vi.waitFor(() => {
      expect(channel.sent.some((frame) => typeof frame === 'string' && JSON.parse(frame).t === 'complete')).toBe(true);
    });

    const controls = channel.sent.filter((frame): frame is string => typeof frame === 'string').map((frame) => JSON.parse(frame));
    expect(controls[0]).toMatchObject({ t: 'header', kind: 'text', size: Buffer.byteLength(body) });
    expect(controls.at(-1)).toMatchObject({ t: 'complete', bytes: Buffer.byteLength(body) });
    expect(controls.at(-1).sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.concat(channel.sent.filter((frame): frame is Uint8Array => typeof frame !== 'string').map(Buffer.from)).toString()).toBe(body);
    manager.cancel('transfer-1', 'peer-a');
  });

  it('streams unsupported binary formats so the PWA can download them', async () => {
    const body = Buffer.from([0, 1, 2, 3, 255]);
    await writeFile(join(dir, 'archive.bin'), body);
    const manager = new FileRtcStreamManager({ onCommand: () => {}, onSubscribe: () => {}, publish: () => {} });

    await manager.connect({ transferId: 'binary-download', cwd: dir, path: 'archive.bin', sdp: 'offer' }, 'peer-a');
    const channel = new FakeDataChannel();
    latestPc?.ondatachannel?.({ channel });
    await vi.waitFor(() => {
      expect(channel.sent.some((frame) => typeof frame === 'string' && JSON.parse(frame).t === 'complete')).toBe(true);
    });

    const controls = channel.sent.filter((frame): frame is string => typeof frame === 'string').map((frame) => JSON.parse(frame));
    expect(controls[0]).toMatchObject({ t: 'header', kind: 'binary', size: body.byteLength });
    expect(controls.at(-1)).toMatchObject({ t: 'complete', bytes: body.byteLength });
    expect(Buffer.concat(channel.sent.filter((frame): frame is Uint8Array => typeof frame !== 'string').map(Buffer.from))).toEqual(body);
    manager.cancel('binary-download', 'peer-a');
  });

  it('labels common audio files for native playback while streaming their bytes', async () => {
    const body = Buffer.from([0x49, 0x44, 0x33, 0, 1, 2, 3]);
    await writeFile(join(dir, 'recording.mp3'), body);
    const manager = new FileRtcStreamManager({ onCommand: () => {}, onSubscribe: () => {}, publish: () => {} });

    await manager.connect({ transferId: 'audio-playback', cwd: dir, path: 'recording.mp3', sdp: 'offer' }, 'peer-a');
    const channel = new FakeDataChannel();
    latestPc?.ondatachannel?.({ channel });
    await vi.waitFor(() => {
      expect(channel.sent.some((frame) => typeof frame === 'string' && JSON.parse(frame).t === 'complete')).toBe(true);
    });

    const header = JSON.parse(channel.sent.find((frame): frame is string => typeof frame === 'string') ?? '{}');
    expect(header).toMatchObject({ t: 'header', kind: 'binary', mimeType: 'audio/mpeg', size: body.byteLength });
    expect(Buffer.concat(channel.sent.filter((frame): frame is Uint8Array => typeof frame !== 'string').map(Buffer.from))).toEqual(body);
    manager.cancel('audio-playback', 'peer-a');
  });

  it('does not let another bus peer add ICE or cancel a transfer', async () => {
    await writeFile(join(dir, 'large.txt'), 'hello');
    const manager = new FileRtcStreamManager({ onCommand: () => {}, onSubscribe: () => {}, publish: () => {} });
    await manager.connect({ transferId: 'owned', cwd: dir, path: 'large.txt', sdp: 'offer' }, 'peer-a');
    await expect(manager.addIce({ transferId: 'owned', candidate: '{}' }, 'peer-b'))
      .resolves.toMatchObject({ ok: false });
    expect(manager.cancel('owned', 'peer-b')).toEqual({ ok: true });
    expect(manager.cancel('owned', 'peer-a')).toEqual({ ok: true });
  });
});
