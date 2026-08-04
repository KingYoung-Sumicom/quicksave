// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * OpenAI-compatible text-to-speech for the voice intermediary. POSTs to
 * `{baseUrl}/audio/speech` and returns raw audio bytes. The daemon synthesizes
 * (keeping the API key server-side) and hands the PWA an id to fetch on demand.
 */
import type { VoiceConfig } from '@sumicom/quicksave-shared';
import { randomUUID } from 'crypto';
import type { FetchLike } from './llm.js';

export interface SynthesizedSpeech {
  audio: Buffer;
  mimeType: string;
  requestId?: string;
  /** Audio was already delivered over the session's WebRTC media track. */
  streamed?: boolean;
  /** Playback was cancelled by a newer user utterance. */
  interrupted?: boolean;
}

export class VoiceTtsError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'VoiceTtsError';
  }
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`;
}

function authHeaders(config: VoiceConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  return headers;
}

async function requestSpeech(
  config: VoiceConfig,
  text: string,
  responseFormat: 'mp3' | 'pcm',
  opts?: { signal?: AbortSignal; fetchImpl?: FetchLike },
): Promise<{ response: Response; requestId: string }> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const clientRequestId = `quicksave-tts-${randomUUID()}`;
  const instructions = config.ttsInstructions?.trim();
  let response: Response;
  try {
    response = await doFetch(apiUrl(config.baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: {
        ...authHeaders(config),
        'X-Client-Request-Id': clientRequestId,
      },
      body: JSON.stringify({
        model: config.ttsModel?.trim(),
        voice: config.ttsVoice?.trim() || 'alloy',
        input: text,
        response_format: responseFormat,
        ...(instructions ? { instructions } : {}),
      }),
      signal: opts?.signal,
    });
  } catch (err) {
    throw new VoiceTtsError('Could not reach the speech endpoint.', err);
  }

  const requestId = response.headers.get('x-request-id') ?? clientRequestId;
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new VoiceTtsError(
      `Speech synthesis failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      undefined,
      response.status,
      requestId,
    );
  }
  return { response, requestId };
}

/**
 * Synthesize `text` to speech. Returns null (silent) when no `ttsModel` is
 * configured — the agent still works, just text-only. Throws on transport /
 * server errors so the session can surface them.
 */
export async function synthesizeSpeech(
  config: VoiceConfig,
  text: string,
  opts?: { signal?: AbortSignal; fetchImpl?: FetchLike },
): Promise<SynthesizedSpeech | null> {
  const model = config.ttsModel?.trim();
  if (!model || !text.trim()) return null;

  const { response, requestId } = await requestSpeech(config, text, 'mp3', opts);
  const audio = Buffer.from(await response.arrayBuffer());
  return { audio, mimeType: response.headers.get('content-type') ?? 'audio/mpeg', requestId };
}

/** Stream raw 24 kHz mono PCM16 chunks from an OpenAI-compatible TTS endpoint. */
export async function streamPcmSpeech(
  config: VoiceConfig,
  text: string,
  onChunk: (chunk: Buffer) => Promise<void> | void,
  opts?: { signal?: AbortSignal; fetchImpl?: FetchLike },
): Promise<SynthesizedSpeech | null> {
  const model = config.ttsModel?.trim();
  if (!model || !text.trim()) return null;
  const { response, requestId } = await requestSpeech(config, text, 'pcm', opts);
  if (!response.body) throw new VoiceTtsError('Speech endpoint returned no audio stream.', undefined, response.status, requestId);

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    const chunk = Buffer.from(value);
    await onChunk(chunk);
  }
  return {
    audio: Buffer.alloc(0),
    mimeType: 'audio/pcm;rate=24000;channels=1',
    requestId,
    streamed: true,
  };
}
