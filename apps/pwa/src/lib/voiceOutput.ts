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
   *  short. Rejects only when playback could not start. */
  play(bytes: Uint8Array, mimeType: string, onStart?: () => void): Promise<void>;
  /** Stop the current clip now (settles the pending `play`). */
  stop(): void;
}

export type AudioFetcher = (audioId: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

export interface VoiceCueBackend {
  playGraceCue(): void;
  startProcessingCue(): void;
  stopProcessingCue(): void;
  dispose(): void;
}

/**
 * Local, non-TTS audio cues for hands-free voice flow:
 * - a short, soft cue when the grace window starts,
 * - a quiet rhythmic cue while the voice intermediary is processing.
 */
export class VoiceCues {
  constructor(private readonly backend: VoiceCueBackend = new WebAudioCueBackend()) {}

  graceStarted(): void {
    this.backend.stopProcessingCue();
    this.backend.playGraceCue();
  }

  processingStarted(): void {
    this.backend.startProcessingCue();
  }

  stopProcessing(): void {
    this.backend.stopProcessingCue();
  }

  dispose(): void {
    this.backend.dispose();
  }
}

export class VoiceOutput {
  private queue: string[] = [];
  private pumping = false;
  private currentAudioId: string | undefined;
  /** Bumped on every interrupt; in-flight fetch/playback compares against it. */
  private generation = 0;

  constructor(
    private readonly fetcher: AudioFetcher,
    private readonly player: AudioPlayer = new BrowserAudioPlayer(),
    private readonly opts: {
      onPlaybackStart?: (audioId: string) => void;
      onPlaybackEnd?: (audioId: string) => void;
      onPlaybackInterrupted?: (audioId?: string) => void;
      onPlaybackUnavailable?: (audioId: string) => void;
    } = {},
  ) {}

  enqueue(audioId: string): void {
    if (!audioId) return;
    this.queue.push(audioId);
    void this.pump();
  }

  /** Barge-in: discard everything queued and stop what's playing. */
  interrupt(opts: { report?: boolean } = {}): void {
    const report = opts.report !== false;
    this.generation++;
    this.queue = [];
    this.player.stop();
    if (report && this.currentAudioId) this.opts.onPlaybackInterrupted?.(this.currentAudioId);
    this.currentAudioId = undefined;
  }

  dispose(): void {
    this.interrupt({ report: false });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const gen = this.generation;
        const audioId = this.queue.shift()!;
        this.currentAudioId = audioId;
        const clip = await this.fetcher(audioId).catch(() => null);
        if (gen !== this.generation) return; // barged during fetch
        if (!clip) {
          this.opts.onPlaybackUnavailable?.(audioId);
          if (this.currentAudioId === audioId) this.currentAudioId = undefined;
          continue;
        }
        const played = await this.player.play(clip.bytes, clip.mimeType, () => this.opts.onPlaybackStart?.(audioId))
          .then(() => true)
          .catch(() => false);
        if (gen !== this.generation) return; // barged during playback
        if (!played) {
          this.opts.onPlaybackUnavailable?.(audioId);
          if (this.currentAudioId === audioId) this.currentAudioId = undefined;
          continue;
        }
        this.opts.onPlaybackEnd?.(audioId);
        if (this.currentAudioId === audioId) this.currentAudioId = undefined;
      }
    } finally {
      this.pumping = false;
      // A late enqueue that raced the unwinding loop still gets serviced.
      if (this.queue.length > 0) void this.pump();
    }
  }
}

class WebAudioCueBackend implements VoiceCueBackend {
  private processingTimer: ReturnType<typeof setInterval> | null = null;

  playGraceCue(): void {
    this.playTone(660, 0.07, 0, 0.12);
    this.playTone(880, 0.08, 0.11, 0.11);
  }

  startProcessingCue(): void {
    if (this.processingTimer) return;
    this.playProcessingPulse();
    this.processingTimer = setInterval(() => this.playProcessingPulse(), 1200);
  }

  stopProcessingCue(): void {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
  }

  dispose(): void {
    this.stopProcessingCue();
  }

  private playProcessingPulse(): void {
    this.playTone(520, 0.055, 0, 0.09);
    this.playTone(620, 0.055, 0.09, 0.08);
  }

  private playTone(frequency: number, durationSec: number, delaySec = 0, volume = 0.03): void {
    const ctx = this.audioContext();
    if (!ctx) return;
    try {
      const start = ctx.currentTime + delaySec;
      const end = start + durationSec;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.02);
      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          /* ignore */
        }
      };
    } catch {
      // Local cues are optional; failures must never affect voice input.
    }
  }

  private audioContext(): AudioContext | null {
    return getSharedAudioContext();
  }
}

let sharedAudioContext: AudioContext | null = null;

function getSharedAudioContext(): AudioContext | null {
  if (sharedAudioContext) return sharedAudioContext;
  if (typeof window === 'undefined') return null;
  const audioWindow = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedAudioContext = new Ctor();
    return sharedAudioContext;
  } catch {
    return null;
  }
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function decodeAudioData(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return await ctx.decodeAudioData(data);
}

/** Browser default: use the same Web Audio context as local cues, then fall
 * back to HTMLAudioElement for browsers/codecs where Web Audio decode fails. */
export class BrowserAudioPlayer implements AudioPlayer {
  private readonly webAudio = new WebAudioSpeechPlayer();
  private readonly htmlAudio = new HtmlAudioPlayer();

  async play(bytes: Uint8Array, mimeType: string, onStart?: () => void): Promise<void> {
    try {
      await this.webAudio.play(bytes, mimeType, onStart);
    } catch (webAudioErr) {
      try {
        await this.htmlAudio.play(bytes, mimeType, onStart);
      } catch {
        throw webAudioErr;
      }
    }
  }

  stop(): void {
    this.webAudio.stop();
    this.htmlAudio.stop();
  }
}

export class WebAudioSpeechPlayer implements AudioPlayer {
  private source: AudioBufferSourceNode | null = null;
  private settle: (() => void) | null = null;

  async play(bytes: Uint8Array, _mimeType: string, onStart?: () => void): Promise<void> {
    this.stop();
    const ctx = getSharedAudioContext();
    if (!ctx) throw new Error('Web Audio is unavailable.');
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => undefined);
    }
    if (ctx.state === 'suspended') throw new Error('Audio context is suspended.');
    const audioBuffer = await decodeAudioData(ctx, bytesToArrayBuffer(bytes));
    return new Promise<void>((resolve) => {
      let active = true;
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      const done = () => {
        if (!active) return;
        active = false;
        if (this.settle === done) this.settle = null;
        if (this.source === source) this.source = null;
        try {
          source.disconnect();
        } catch {
          /* ignore */
        }
        resolve();
      };
      this.source = source;
      this.settle = done;
      source.onended = done;
      source.start();
      onStart?.();
    });
  }

  stop(): void {
    const settle = this.settle;
    this.settle = null;
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* ignore */
      }
      try {
        this.source.disconnect();
      } catch {
        /* ignore */
      }
      this.source = null;
    }
    settle?.();
  }
}

/** Browser `HTMLAudioElement`-backed player. */
export class HtmlAudioPlayer implements AudioPlayer {
  private el: HTMLAudioElement | null = null;
  private url: string | null = null;
  private settle: (() => void) | null = null;

  play(bytes: Uint8Array, mimeType: string, onStart?: () => void): Promise<void> {
    this.stop();
    const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType || 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    this.el = el;
    this.url = url;
    return new Promise<void>((resolve, reject) => {
      let active = true;
      let started = false;
      const markStarted = () => {
        if (!active || started) return;
        started = true;
        onStart?.();
      };
      const done = () => {
        active = false;
        if (this.settle === done) this.settle = null;
        this.cleanup(el, url);
        resolve();
      };
      const failed = () => {
        active = false;
        if (this.settle === done) this.settle = null;
        this.cleanup(el, url);
        reject(new Error('Audio playback did not start.'));
      };
      this.settle = done;
      el.onplaying = markStarted;
      el.onended = done;
      el.onerror = () => (started ? done() : failed());
      el.play().then(markStarted).catch(() => failed());
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
    el.onplaying = null;
    el.onended = null;
    el.onerror = null;
    if (this.el === el) this.el = null;
    if (this.url === url) {
      URL.revokeObjectURL(url);
      this.url = null;
    }
  }
}
