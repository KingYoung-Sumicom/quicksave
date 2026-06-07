// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  VoiceCues,
  VoiceOutput,
  type AudioPlayer,
  type AudioFetcher,
  type VoiceCueBackend,
} from './voiceOutput';

/** A player whose clips finish only when the test says so. */
class FakePlayer implements AudioPlayer {
  played: number[] = [];
  private resolveCurrent: (() => void) | null = null;

  play(bytes: Uint8Array, _mimeType: string, onStart?: () => void): Promise<void> {
    this.played.push(bytes[0]);
    onStart?.();
    return new Promise<void>((resolve) => {
      this.resolveCurrent = resolve;
    });
  }

  stop(): void {
    const r = this.resolveCurrent;
    this.resolveCurrent = null;
    r?.();
  }

  /** Simulate the current clip finishing on its own. */
  finish(): void {
    this.stop();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const fetcher: AudioFetcher = async (id) => ({ bytes: Uint8Array.from([Number(id)]), mimeType: 'audio/mpeg' });

class FakeCueBackend implements VoiceCueBackend {
  calls: string[] = [];
  playGraceCue(): void { this.calls.push('grace'); }
  startProcessingCue(): void { this.calls.push('processing:start'); }
  stopProcessingCue(): void { this.calls.push('processing:stop'); }
  dispose(): void { this.calls.push('dispose'); }
}

class RejectingPlayer implements AudioPlayer {
  play(): Promise<void> {
    return Promise.reject(new Error('blocked'));
  }

  stop(): void {
    /* no-op */
  }
}

describe('VoiceCues', () => {
  it('plays a short grace cue after stopping any processing cue', () => {
    const backend = new FakeCueBackend();
    const cues = new VoiceCues(backend);
    cues.graceStarted();
    expect(backend.calls).toEqual(['processing:stop', 'grace']);
  });

  it('starts and stops the processing cue independently', () => {
    const backend = new FakeCueBackend();
    const cues = new VoiceCues(backend);
    cues.processingStarted();
    cues.stopProcessing();
    cues.dispose();
    expect(backend.calls).toEqual(['processing:start', 'processing:stop', 'dispose']);
  });
});

describe('VoiceOutput', () => {
  it('plays queued clips one after another in order', async () => {
    const player = new FakePlayer();
    const out = new VoiceOutput(fetcher, player);

    out.enqueue('1');
    out.enqueue('2');
    await tick();
    expect(player.played).toEqual([1]); // second waits for the first

    player.finish();
    await tick();
    expect(player.played).toEqual([1, 2]);
    player.finish();
  });

  it('barge-in drops the queue and stops the current clip', async () => {
    const player = new FakePlayer();
    const out = new VoiceOutput(fetcher, player);

    out.enqueue('1');
    out.enqueue('2');
    await tick();
    expect(player.played).toEqual([1]);

    out.interrupt(); // user starts talking
    await tick();
    expect(player.played).toEqual([1]); // '2' never plays

    // new speech after barge-in still works
    out.enqueue('3');
    await tick();
    expect(player.played).toEqual([1, 3]);
    player.finish();
  });

  it('ignores empty audio ids', async () => {
    const player = new FakePlayer();
    const out = new VoiceOutput(fetcher, player);
    out.enqueue('');
    await tick();
    expect(player.played).toEqual([]);
  });

  it('skips a clip whose bytes have expired (fetch returns null)', async () => {
    const player = new FakePlayer();
    const out = new VoiceOutput(async (id) => (id === '1' ? null : { bytes: Uint8Array.from([Number(id)]), mimeType: 'audio/mpeg' }), player);
    out.enqueue('1');
    out.enqueue('2');
    await tick();
    expect(player.played).toEqual([2]); // expired '1' skipped, moves on
    player.finish();
  });

  it('reports playback start only when the player starts a fetched clip', async () => {
    const player = new FakePlayer();
    const started: string[] = [];
    const out = new VoiceOutput(fetcher, player, { onPlaybackStart: (audioId) => started.push(`start:${audioId}`) });

    out.enqueue('1');
    await tick();
    expect(player.played).toEqual([1]);
    expect(started).toEqual(['start:1']);
    player.finish();
  });

  it('reports playback end when a fetched clip finishes and interrupted when stopped early', async () => {
    const player = new FakePlayer();
    const ended: string[] = [];
    const interrupted: string[] = [];
    const out = new VoiceOutput(fetcher, player, {
      onPlaybackEnd: (audioId) => ended.push(`end:${audioId}`),
      onPlaybackInterrupted: (audioId) => interrupted.push(`interrupted:${audioId}`),
    });

    out.enqueue('1');
    await tick();
    player.finish();
    await tick();
    expect(ended).toEqual(['end:1']);

    out.enqueue('2');
    await tick();
    out.interrupt();
    await tick();
    expect(ended).toEqual(['end:1']);
    expect(interrupted).toEqual(['interrupted:2']);
  });

  it('reports unavailable playback when the audio id can no longer be fetched', async () => {
    const player = new FakePlayer();
    const unavailable: string[] = [];
    const out = new VoiceOutput(async () => null, player, {
      onPlaybackUnavailable: (audioId) => unavailable.push(`missing:${audioId}`),
    });

    out.enqueue('1');
    await tick();
    expect(player.played).toEqual([]);
    expect(unavailable).toEqual(['missing:1']);
  });

  it('reports unavailable playback when browser playback cannot start', async () => {
    const unavailable: string[] = [];
    const ended: string[] = [];
    const out = new VoiceOutput(fetcher, new RejectingPlayer(), {
      onPlaybackUnavailable: (audioId) => unavailable.push(`missing:${audioId}`),
      onPlaybackEnd: (audioId) => ended.push(`end:${audioId}`),
    });

    out.enqueue('1');
    await tick();
    await tick();

    expect(unavailable).toEqual(['missing:1']);
    expect(ended).toEqual([]);
  });

  it('does not report interrupted when idle or disposed', async () => {
    const player = new FakePlayer();
    const interrupted: string[] = [];
    const out = new VoiceOutput(fetcher, player, {
      onPlaybackInterrupted: (audioId) => interrupted.push(`interrupted:${audioId}`),
    });

    out.interrupt();
    out.enqueue('1');
    await tick();
    out.dispose();
    await tick();

    expect(interrupted).toEqual([]);
  });
});
