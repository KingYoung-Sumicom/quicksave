// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RealtimeTranscriber, realtimeUrl, type RealtimeSocket } from './realtimeTranscription.js';
import type { VoiceConfig } from '@sumicom/quicksave-shared';

const config: VoiceConfig = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  mode: 'streaming',
  transcribeModel: 'whisper-1',
  streamModel: 'gpt-4o-transcribe',
};

class FakeSocket implements RealtimeSocket {
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, (arg?: unknown) => void> = {};
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.emit('close'); }
  on(event: string, cb: (arg?: unknown) => void) { this.handlers[event] = cb; }
  emit(event: string, arg?: unknown) { this.handlers[event]?.(arg); }
}

let socket: FakeSocket;
let factoryArgs: { url: string; headers: Record<string, string> };

function newTranscriber(cb = makeCb()) {
  return new RealtimeTranscriber(config, 24_000, cb, (url, headers) => {
    factoryArgs = { url, headers };
    socket = new FakeSocket();
    return socket;
  });
}

function makeCb() {
  return {
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
    onSpeechStarted: vi.fn(),
    onSpeechStopped: vi.fn(),
    onClose: vi.fn(),
  };
}

beforeEach(() => {
  socket = undefined as unknown as FakeSocket;
});

describe('realtimeUrl', () => {
  it('converts https base URL to a wss realtime transcription URL', () => {
    expect(realtimeUrl('https://api.openai.com/v1')).toBe(
      'wss://api.openai.com/v1/realtime?intent=transcription',
    );
    expect(realtimeUrl('http://localhost:8000/v1/')).toBe(
      'ws://localhost:8000/v1/realtime?intent=transcription',
    );
  });
});

describe('RealtimeTranscriber', () => {
  it('connects with auth header (no beta header) and sends a GA session config on open', () => {
    const t = newTranscriber();
    t.start();
    expect(factoryArgs.url).toBe('wss://api.openai.com/v1/realtime?intent=transcription');
    expect(factoryArgs.headers.Authorization).toBe('Bearer sk-test');
    expect(factoryArgs.headers['OpenAI-Beta']).toBeUndefined();

    socket.emit('open');
    const cfg = JSON.parse(socket.sent[0]);
    expect(cfg.type).toBe('session.update');
    expect(cfg.session.type).toBe('transcription');
    expect(cfg.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24_000 });
    expect(cfg.session.audio.input.transcription.model).toBe('gpt-4o-transcribe');
    expect(cfg.session.audio.input.turn_detection).toMatchObject({
      type: 'server_vad',
      silence_duration_ms: 2000,
    });
  });

  it('buffers audio sent before open, then flushes after open', () => {
    const t = newTranscriber();
    t.start();
    t.appendAudio(Buffer.from([1, 2, 3, 4])); // before open → queued
    expect(socket.sent).toHaveLength(0);
    socket.emit('open');
    // [0] = session config, [1] = the queued append
    const append = JSON.parse(socket.sent[1]);
    expect(append.type).toBe('input_audio_buffer.append');
    expect(Buffer.from(append.audio, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('sends a commit after audio was appended', () => {
    const t = newTranscriber();
    t.start();
    socket.emit('open');
    t.appendAudio(Buffer.from([1, 2]));
    t.commit();
    expect(JSON.parse(socket.sent.at(-1)!).type).toBe('input_audio_buffer.commit');
  });

  it('skips commit when no audio was appended (avoids empty-buffer error)', () => {
    const t = newTranscriber();
    t.start();
    socket.emit('open');
    const before = socket.sent.length;
    t.commit();
    expect(socket.sent.length).toBe(before); // nothing sent
  });

  it('routes delta events to onPartial and completed to onFinal', () => {
    const cb = makeCb();
    const t = newTranscriber(cb);
    t.start();
    socket.emit('open');
    socket.emit('message', JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'he' }));
    socket.emit('message', JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'llo' }));
    socket.emit('message', JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello' }));
    expect(cb.onPartial).toHaveBeenNthCalledWith(1, 'he');
    expect(cb.onPartial).toHaveBeenNthCalledWith(2, 'llo');
    expect(cb.onFinal).toHaveBeenCalledWith('hello');
  });

  it('routes server VAD speech events to callbacks', () => {
    const cb = makeCb();
    const t = newTranscriber(cb);
    t.start();
    socket.emit('open');
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    expect(cb.onSpeechStarted).toHaveBeenCalledOnce();
    expect(cb.onSpeechStopped).toHaveBeenCalledOnce();
  });

  it('routes error events to onError', () => {
    const cb = makeCb();
    const t = newTranscriber(cb);
    t.start();
    socket.emit('open');
    socket.emit('message', JSON.stringify({ type: 'error', error: { message: 'bad audio' } }));
    expect(cb.onError).toHaveBeenCalledWith('bad audio');
  });

  it('suppresses the benign empty-buffer commit error', () => {
    const cb = makeCb();
    const t = newTranscriber(cb);
    t.start();
    socket.emit('open');
    socket.emit('message', JSON.stringify({
      type: 'error',
      error: { code: 'input_audio_buffer_commit_empty', message: 'buffer too small. Expected at least 100ms' },
    }));
    socket.emit('message', JSON.stringify({
      type: 'error',
      error: { message: 'Error committing input audio buffer: buffer too small, but buffer only has 0.00ms' },
    }));
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('ignores unparseable frames', () => {
    const cb = makeCb();
    const t = newTranscriber(cb);
    t.start();
    socket.emit('open');
    socket.emit('message', 'not json');
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onPartial).not.toHaveBeenCalled();
  });

  it('fires onClose and stops sending after close()', () => {
    const cb = makeCb();
    const t = newTranscriber(cb);
    t.start();
    socket.emit('open');
    t.close();
    expect(socket.closed).toBe(true);
    expect(cb.onClose).toHaveBeenCalled();
    const before = socket.sent.length;
    t.appendAudio(Buffer.from([9]));
    expect(socket.sent.length).toBe(before); // no send after close
  });
});
