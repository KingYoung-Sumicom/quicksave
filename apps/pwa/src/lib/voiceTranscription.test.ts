// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  transcribeViaAgent,
  listModelsViaAgent,
  isVoiceConfigUsable,
  VoiceTranscriptionError,
  MAX_AUDIO_BYTES,
} from './voiceTranscription';
import { registerAgentBusGetter } from './busRegistry';
import type { VoiceConfig } from '@sumicom/quicksave-shared';

const config: VoiceConfig = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  model: 'whisper-1',
};

const AGENT = 'agent-1';
let command: ReturnType<typeof vi.fn>;

function installBus(getter: (agentId: string) => unknown | null) {
  registerAgentBusGetter(getter as never);
}

beforeEach(() => {
  command = vi.fn();
  installBus((agentId) => (agentId === AGENT ? { command } : null));
});

afterEach(() => {
  registerAgentBusGetter(null as never);
});

describe('isVoiceConfigUsable', () => {
  it('requires baseUrl and model, not apiKey', () => {
    expect(isVoiceConfigUsable(config)).toBe(true);
    expect(isVoiceConfigUsable(null)).toBe(false);
    expect(isVoiceConfigUsable({ ...config, baseUrl: ' ' })).toBe(false);
    expect(isVoiceConfigUsable({ ...config, apiKey: '' })).toBe(true);
  });
});

describe('transcribeViaAgent', () => {
  const audio = new Blob([new Uint8Array(2048)], { type: 'audio/webm' }); // ≥ MIN_AUDIO_BYTES

  it('throws when config is unusable, without dispatching', async () => {
    await expect(transcribeViaAgent(audio, { ...config, baseUrl: '' }, AGENT)).rejects.toBeInstanceOf(
      VoiceTranscriptionError,
    );
    expect(command).not.toHaveBeenCalled();
  });

  it('throws when no bus is registered for the agent', async () => {
    await expect(transcribeViaAgent(audio, config, 'other-agent')).rejects.toThrow(/Not connected/);
  });

  it('rejects an effectively-empty recording without dispatching', async () => {
    const tiny = new Blob([new Uint8Array(100)], { type: 'audio/webm' });
    await expect(transcribeViaAgent(tiny, config, AGENT)).rejects.toThrow(/No speech captured/);
    expect(command).not.toHaveBeenCalled();
  });

  it('rejects recordings larger than the frame cap', async () => {
    const big = new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)], { type: 'audio/webm' });
    await expect(transcribeViaAgent(big, config, AGENT)).rejects.toThrow(/too long/);
    expect(command).not.toHaveBeenCalled();
  });

  it('dispatches voice:transcribe and returns the text', async () => {
    command.mockResolvedValue({ text: 'hello' });
    const text = await transcribeViaAgent(audio, config, AGENT);
    expect(text).toBe('hello');
    const [verb, payload] = command.mock.calls[0];
    expect(verb).toBe('voice:transcribe');
    expect(payload.mimeType).toBe('audio/webm');
    expect(typeof payload.audioBase64).toBe('string');
    expect(payload.config).toEqual(config);
  });

  it('surfaces an agent-side error from the response', async () => {
    command.mockResolvedValue({ text: '', error: 'Transcription failed (401)' });
    await expect(transcribeViaAgent(audio, config, AGENT)).rejects.toThrow(/401/);
  });
});

describe('listModelsViaAgent', () => {
  it('returns the model list', async () => {
    command.mockResolvedValue({ models: ['whisper-1', 'gpt-4o-transcribe'] });
    expect(await listModelsViaAgent(config, AGENT)).toEqual(['whisper-1', 'gpt-4o-transcribe']);
    expect(command.mock.calls[0][0]).toBe('voice:list-models');
  });

  it('throws on agent-side error', async () => {
    command.mockResolvedValue({ models: [], error: 'Listing models failed (403)' });
    await expect(listModelsViaAgent(config, AGENT)).rejects.toThrow(/403/);
  });

  it('throws when no bus is registered', async () => {
    await expect(listModelsViaAgent(config, 'other-agent')).rejects.toThrow(/Not connected/);
  });
});
