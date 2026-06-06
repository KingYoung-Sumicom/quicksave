// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * OpenAI-compatible text-to-speech for the voice intermediary. POSTs to
 * `{baseUrl}/audio/speech` and returns raw audio bytes. The daemon synthesizes
 * (keeping the API key server-side) and hands the PWA an id to fetch on demand.
 */
import type { VoiceConfig } from '@sumicom/quicksave-shared';
import type { FetchLike } from './llm.js';

export interface SynthesizedSpeech {
  audio: Buffer;
  mimeType: string;
}

export class VoiceTtsError extends Error {
  constructor(message: string, readonly cause?: unknown) {
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

  const doFetch = opts?.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(apiUrl(config.baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        model,
        voice: config.ttsVoice?.trim() || 'alloy',
        input: text,
        response_format: 'mp3',
      }),
      signal: opts?.signal,
    });
  } catch (err) {
    throw new VoiceTtsError('Could not reach the speech endpoint.', err);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new VoiceTtsError(`Speech synthesis failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const audio = Buffer.from(await res.arrayBuffer());
  return { audio, mimeType: 'audio/mpeg' };
}
