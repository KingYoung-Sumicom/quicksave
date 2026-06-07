// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Agent-side bridge to a streaming, OpenAI-Realtime-compatible transcription
 * API. Runs on the agent (Node) so there is no browser CORS limit and the same
 * code path serves OpenAI's hosted endpoint and self-hosted servers that speak
 * the Realtime protocol.
 *
 * Lifecycle: construct → `start()` (opens the WS, configures the session) →
 * `appendAudio(pcm16)` repeatedly as frames arrive → `commit()` at end of
 * utterance → `close()`. Partial/final transcripts arrive via callbacks.
 *
 * The `ws` constructor is injectable so unit tests can drive the protocol
 * without a real socket.
 */
import WS from 'ws';
import type { VoiceConfig } from '@sumicom/quicksave-shared';

export interface RealtimeCallbacks {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(message: string): void;
  onSpeechStarted?(): void;
  onSpeechStopped?(): void;
  onClose?(): void;
}

/** Minimal surface we use from a WebSocket; satisfied by `ws`. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'error' | 'close', cb: (arg?: unknown) => void): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => RealtimeSocket;

const defaultFactory: SocketFactory = (url, headers) =>
  new WS(url, { headers }) as unknown as RealtimeSocket;

/** Derive the realtime WS URL from an http(s) base URL. */
export function realtimeUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const ws = trimmed.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return `${ws}/realtime?intent=transcription`;
}

export class RealtimeTranscriber {
  private socket: RealtimeSocket | null = null;
  private opened = false;
  private closed = false;
  private appendedSinceCommit = false;
  private readonly pending: string[] = [];

  constructor(
    private readonly config: VoiceConfig,
    private readonly sampleRate: number,
    private readonly cb: RealtimeCallbacks,
    private readonly factory: SocketFactory = defaultFactory,
  ) {}

  start(): void {
    if (!(this.sampleRate > 0)) {
      this.cb.onError('Invalid audio sample rate');
      return;
    }
    if (!this.config.streamModel.trim()) {
      this.cb.onError('No streaming model configured. Set a realtime model (e.g. gpt-4o-transcribe) in Settings.');
      return;
    }
    // GA Realtime API: no `OpenAI-Beta` header (the beta interface is gone).
    const headers: Record<string, string> = {};
    if (this.config.apiKey.trim()) headers.Authorization = `Bearer ${this.config.apiKey.trim()}`;

    const socket = this.factory(realtimeUrl(this.config.baseUrl), headers);
    this.socket = socket;

    socket.on('open', () => {
      this.opened = true;
      // Configure the transcription session (GA shape): raw PCM16 in at our
      // capture rate, chosen model. `gpt-realtime-whisper` requires manual
      // commit (no server VAD), which matches our explicit `commit()`.
      this.rawSend(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: this.sampleRate },
                transcription: { model: this.config.streamModel.trim() },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 2000,
                },
              },
            },
          },
        }),
      );
      for (const msg of this.pending.splice(0)) this.rawSend(msg);
    });
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('error', (err) => {
      this.cb.onError(err instanceof Error ? err.message : 'Realtime socket error');
    });
    socket.on('close', () => {
      this.closed = true;
      this.cb.onClose?.();
    });
  }

  /** Queue a frame of PCM16 mono audio for transcription. */
  appendAudio(pcm16: Buffer | Uint8Array): void {
    const audio = Buffer.from(pcm16).toString('base64');
    this.appendedSinceCommit = true;
    this.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
  }

  /** Signal end-of-utterance so the server finalizes the transcript. Skipped
   *  when nothing new was appended (server VAD may have already committed). */
  commit(): void {
    if (!this.appendedSinceCommit) return;
    this.appendedSinceCommit = false;
    this.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  private send(msg: string): void {
    if (this.closed) return;
    if (!this.opened) {
      this.pending.push(msg);
      return;
    }
    this.rawSend(msg);
  }

  private rawSend(msg: string): void {
    try {
      this.socket?.send(msg);
    } catch (err) {
      this.cb.onError(err instanceof Error ? err.message : 'Failed to send to realtime socket');
    }
  }

  private handleMessage(data: unknown): void {
    let evt: { type?: string; delta?: unknown; transcript?: unknown; error?: { message?: unknown; code?: unknown } };
    try {
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      evt = JSON.parse(text);
    } catch {
      return; // ignore unparseable frames
    }
    const type = typeof evt.type === 'string' ? evt.type : '';

    if (type === 'input_audio_buffer.speech_started') {
      this.cb.onSpeechStarted?.();
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      this.cb.onSpeechStopped?.();
      return;
    }

    // Tolerant matching so minor schema drift across providers/versions still
    // routes partial vs final correctly.
    if (type.endsWith('input_audio_transcription.delta')) {
      if (typeof evt.delta === 'string' && evt.delta.length > 0) this.cb.onPartial(evt.delta);
      return;
    }
    if (type.endsWith('input_audio_transcription.completed')) {
      if (typeof evt.transcript === 'string') this.cb.onFinal(evt.transcript);
      return;
    }
    if (type === 'error') {
      const code = typeof evt.error?.code === 'string' ? evt.error.code : '';
      const msg = typeof evt.error?.message === 'string' ? evt.error.message : 'Realtime API error';
      // Benign: committing an empty/too-short buffer — typically because server
      // VAD already flushed it. Recognition is unaffected, so don't surface it.
      if (code === 'input_audio_buffer_commit_empty' || /buffer too small|buffer is empty/i.test(msg)) {
        return;
      }
      this.cb.onError(msg);
    }
  }
}
