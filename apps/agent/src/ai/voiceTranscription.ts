// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Agent-side voice transcription against a Whisper-compatible API.
 *
 * Runs on the agent (Node) rather than the PWA so there is no browser CORS
 * constraint — OpenAI's hosted endpoint and self-hosted servers both work.
 * The PWA sends the recording + the user's config; nothing is persisted here.
 */
import type { VoiceConfig } from '@sumicom/quicksave-shared';

/** Below this the audio is effectively empty (decodes to 0 seconds). */
export const MIN_AUDIO_BYTES = 1024;

export class VoiceTranscriptionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'VoiceTranscriptionError';
  }
}

/** True when the config has the minimum needed to attempt a request. */
export function isVoiceConfigUsable(config: VoiceConfig | null | undefined): config is VoiceConfig {
  return !!config && config.baseUrl.trim().length > 0 && config.model.trim().length > 0;
}

/** Join base URL + path without doubling or dropping the slash. */
function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`;
}

function authHeaders(config: VoiceConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  return headers;
}

async function errorDetail(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Transcribe audio bytes to text. Posts multipart/form-data to
 * `{baseUrl}/audio/transcriptions` (OpenAI Whisper API shape).
 *
 * @throws {VoiceTranscriptionError} on misconfiguration, network failure,
 *   non-2xx, or a response missing a usable `text` field.
 */
export async function transcribeAudio(
  audio: Buffer | Uint8Array,
  mimeType: string,
  config: VoiceConfig,
): Promise<string> {
  if (!isVoiceConfigUsable(config)) {
    throw new VoiceTranscriptionError('Voice transcription is not configured.');
  }
  // Reject effectively-empty audio before spending an API round-trip — a
  // near-empty container decodes to 0 seconds and the API rejects it anyway.
  if (audio.length < MIN_AUDIO_BYTES) {
    throw new VoiceTranscriptionError('No speech captured.');
  }

  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType || 'audio/webm' }), `recording.${ext}`);
  form.append('model', config.model.trim());
  form.append('response_format', 'json');

  let res: Response;
  try {
    res = await fetch(apiUrl(config.baseUrl, '/audio/transcriptions'), {
      method: 'POST',
      headers: authHeaders(config),
      body: form,
    });
  } catch (err) {
    throw new VoiceTranscriptionError('Could not reach the transcription server.', err);
  }

  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new VoiceTranscriptionError(
      `Transcription failed (${res.status})${detail ? `: ${detail}` : ''}`,
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new VoiceTranscriptionError('Transcription server returned an invalid response.', err);
  }

  const text = (payload as { text?: unknown } | null)?.text;
  if (typeof text !== 'string') {
    throw new VoiceTranscriptionError('Transcription response did not contain text.');
  }
  return text.trim();
}

/**
 * List model ids from `GET {baseUrl}/models` (OpenAI-compatible). Used to
 * populate the model dropdown in Settings.
 *
 * @throws {VoiceTranscriptionError} on misconfiguration, network/CORS-free
 *   failure, non-2xx, or an unrecognizable response shape.
 */
export async function listModels(config: VoiceConfig): Promise<string[]> {
  if (!config.baseUrl.trim()) {
    throw new VoiceTranscriptionError('No API base URL configured.');
  }

  let res: Response;
  try {
    res = await fetch(apiUrl(config.baseUrl, '/models'), { headers: authHeaders(config) });
  } catch (err) {
    throw new VoiceTranscriptionError('Could not reach the model list endpoint.', err);
  }

  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new VoiceTranscriptionError(
      `Listing models failed (${res.status})${detail ? `: ${detail}` : ''}`,
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new VoiceTranscriptionError('Model list endpoint returned an invalid response.', err);
  }

  // OpenAI shape: { data: [{ id }, ...] }. Some servers return a bare array.
  const data = Array.isArray(payload)
    ? payload
    : (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new VoiceTranscriptionError('Model list response was not in a recognized format.');
  }
  return data
    .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}
