// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from 'vitest';
import { transcribeAudio, listModels, isVoiceConfigUsable, VoiceTranscriptionError } from './voiceTranscription.js';
import type { VoiceConfig } from '@sumicom/quicksave-shared';

const fullConfig: VoiceConfig = {
  apiKey: 'sk-test',
  baseUrl: 'https://whisper.example.com/v1',
  model: 'whisper-1',
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const audio = Buffer.from('fake audio bytes');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isVoiceConfigUsable', () => {
  it('requires baseUrl and model, but not apiKey', () => {
    expect(isVoiceConfigUsable(fullConfig)).toBe(true);
    expect(isVoiceConfigUsable(null)).toBe(false);
    expect(isVoiceConfigUsable({ ...fullConfig, baseUrl: ' ' })).toBe(false);
    expect(isVoiceConfigUsable({ ...fullConfig, model: '' })).toBe(false);
    expect(isVoiceConfigUsable({ ...fullConfig, apiKey: '' })).toBe(true);
  });
});

describe('transcribeAudio', () => {
  it('throws without calling fetch when config is unusable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(transcribeAudio(audio, 'audio/webm', { ...fullConfig, baseUrl: '' })).rejects.toBeInstanceOf(
      VoiceTranscriptionError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts to {baseUrl}/audio/transcriptions and returns trimmed text', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ text: '  hi there  ' }));
    const result = await transcribeAudio(audio, 'audio/webm', fullConfig);
    expect(result).toBe('hi there');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://whisper.example.com/v1/audio/transcriptions');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('normalizes a trailing slash on the base URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ text: 'x' }));
    await transcribeAudio(audio, 'audio/webm', { ...fullConfig, baseUrl: 'https://whisper.example.com/v1/' });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://whisper.example.com/v1/audio/transcriptions');
  });

  it('omits Authorization when no key is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ text: 'x' }));
    await transcribeAudio(audio, 'audio/webm', { ...fullConfig, apiKey: '' });
    expect((fetchSpy.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('throws with the status on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'nope' }, false, 401));
    await expect(transcribeAudio(audio, 'audio/webm', fullConfig)).rejects.toThrow(/401/);
  });

  it('throws when the response lacks a text field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ notText: 'x' }));
    await expect(transcribeAudio(audio, 'audio/webm', fullConfig)).rejects.toThrow(/did not contain text/);
  });

  it('wraps a network failure in VoiceTranscriptionError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(transcribeAudio(audio, 'audio/webm', fullConfig)).rejects.toBeInstanceOf(VoiceTranscriptionError);
  });
});

describe('listModels', () => {
  it('throws when no baseUrl is configured', async () => {
    await expect(listModels({ ...fullConfig, baseUrl: '' })).rejects.toBeInstanceOf(VoiceTranscriptionError);
  });

  it('parses the OpenAI { data: [{ id }] } shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: [{ id: 'whisper-1' }, { id: 'gpt-4o-transcribe' }] }),
    );
    expect(await listModels(fullConfig)).toEqual(['whisper-1', 'gpt-4o-transcribe']);
  });

  it('accepts a bare array of ids', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(['a', 'b']));
    expect(await listModels(fullConfig)).toEqual(['a', 'b']);
  });

  it('filters out entries without a string id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [{ id: 'ok' }, {}, { id: 5 }] }));
    expect(await listModels(fullConfig)).toEqual(['ok']);
  });

  it('throws on an unrecognized response shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ weird: true }));
    await expect(listModels(fullConfig)).rejects.toThrow(/recognized format/);
  });

  it('throws with the status on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, false, 403));
    await expect(listModels(fullConfig)).rejects.toThrow(/403/);
  });
});
