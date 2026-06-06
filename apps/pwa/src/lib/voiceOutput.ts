// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * Sequential speech playback for the voice intermediary. The agent emits `speak`
 * events carrying an `audioId`; this fetches the bytes on demand and plays them
 * one after another. `interrupt()` is barge-in: it drops the queue and stops the
 * current clip the instant the user starts talking.
 *
 * The actual audio element is abstracted behind `AudioPlayer` so the queue logic
 * (ordering, barge-in) is unit-testable without a real DOM.
 */

export interface AudioPlayer {
  /** Play a clip to completion. Resolves when it ends OR when `stop()` cuts it
   *  short — never rejects, so the queue never wedges on a playback error. */
  play(bytes: Uint8Array, mimeType: string): Promise<void>;
  /** Stop the current clip now (settles the pending `play`). */
  stop(): void;
}

export type AudioFetcher = (audioId: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

export class VoiceOutput {
  private queue: string[] = [];
  private pumping = false;
  /** Bumped on every interrupt; in-flight fetch/playback compares against it. */
  private generation = 0;

  constructor(
    private readonly fetcher: AudioFetcher,
    private readonly player: AudioPlayer = new HtmlAudioPlayer(),
  ) {}

  enqueue(audioId: string): void {
    if (!audioId) return;
    this.queue.push(audioId);
    void this.pump();
  }

  /** Barge-in: discard everything queued and stop what's playing. */
  interrupt(): void {
    this.generation++;
    this.queue = [];
    this.player.stop();
  }

  dispose(): void {
    this.interrupt();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const gen = this.generation;
        const audioId = this.queue.shift()!;
        const clip = await this.fetcher(audioId).catch(() => null);
        if (gen !== this.generation) return; // barged during fetch
        if (!clip) continue;
        await this.player.play(clip.bytes, clip.mimeType);
        if (gen !== this.generation) return; // barged during playback
      }
    } finally {
      this.pumping = false;
      // A late enqueue that raced the unwinding loop still gets serviced.
      if (this.queue.length > 0) void this.pump();
    }
  }
}

/** Browser `HTMLAudioElement`-backed player. */
export class HtmlAudioPlayer implements AudioPlayer {
  private el: HTMLAudioElement | null = null;
  private url: string | null = null;
  private settle: (() => void) | null = null;

  play(bytes: Uint8Array, mimeType: string): Promise<void> {
    this.stop();
    const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType || 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    this.el = el;
    this.url = url;
    return new Promise<void>((resolve) => {
      const done = () => {
        if (this.settle === done) this.settle = null;
        this.cleanup(el, url);
        resolve();
      };
      this.settle = done;
      el.onended = done;
      el.onerror = done;
      el.play().catch(() => done());
    });
  }

  stop(): void {
    const settle = this.settle;
    this.settle = null;
    if (this.el) {
      try {
        this.el.pause();
      } catch {
        /* ignore */
      }
    }
    if (settle) settle();
  }

  private cleanup(el: HTMLAudioElement, url: string): void {
    el.onended = null;
    el.onerror = null;
    if (this.el === el) this.el = null;
    if (this.url === url) {
      URL.revokeObjectURL(url);
      this.url = null;
    }
  }
}
