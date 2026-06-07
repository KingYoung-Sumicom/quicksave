// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { parseVoiceConfig } from './secureStorage';

describe('parseVoiceConfig', () => {
  it('carries the voice-intermediary fields through the round-trip', () => {
    const raw = JSON.stringify({
      apiKey: 'k',
      baseUrl: 'http://x/v1',
      mode: 'batch',
      transcribeModel: 'whisper-1',
      streamModel: 'gpt-4o-transcribe',
      agentModel: 'gpt-4o-mini',
      ttsModel: 'gpt-4o-mini-tts',
      ttsVoice: 'nova',
      ttsInstructions: '聲音自然、溫和，語速稍快。',
    });
    expect(parseVoiceConfig(raw)).toEqual({
      apiKey: 'k',
      baseUrl: 'http://x/v1',
      mode: 'batch',
      transcribeModel: 'whisper-1',
      streamModel: 'gpt-4o-transcribe',
      agentModel: 'gpt-4o-mini',
      ttsModel: 'gpt-4o-mini-tts',
      ttsVoice: 'nova',
      ttsInstructions: '聲音自然、溫和，語速稍快。',
    });
  });

  it('leaves the new fields undefined when absent (still usable)', () => {
    const cfg = parseVoiceConfig(JSON.stringify({ baseUrl: 'http://x/v1', transcribeModel: 'whisper-1' }));
    expect(cfg).toMatchObject({ baseUrl: 'http://x/v1', mode: 'streaming' });
    expect(cfg?.agentModel).toBeUndefined();
    expect(cfg?.ttsModel).toBeUndefined();
    expect(cfg?.ttsVoice).toBeUndefined();
    expect(cfg?.ttsInstructions).toBeUndefined();
  });

  it('migrates the pre-split single `model` field to transcribeModel', () => {
    const cfg = parseVoiceConfig(JSON.stringify({ baseUrl: 'http://x/v1', model: 'whisper-1' }));
    expect(cfg?.transcribeModel).toBe('whisper-1');
  });

  it('returns null on unparseable input', () => {
    expect(parseVoiceConfig('not json')).toBeNull();
  });
});
