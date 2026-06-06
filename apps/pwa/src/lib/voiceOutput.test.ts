// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { VoiceOutput, type AudioPlayer, type AudioFetcher } from './voiceOutput';

/** A player whose clips finish only when the test says so. */
class FakePlayer implements AudioPlayer {
  played: number[] = [];
  private resolveCurrent: (() => void) | null = null;

  play(bytes: Uint8Array): Promise<void> {
    this.played.push(bytes[0]);
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
});
