// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * PWA-side client for voice transcription. The actual HTTP call to the
 * Whisper-compatible API runs on the agent (no browser CORS limit — OpenAI's
 * endpoint works there); this module records-to-bytes, base64-encodes, and
 * dispatches the `voice:transcribe` / `voice:list-models` bus verbs to a
 * specific agent. The config is the user's synced single source of truth and
 * travels in the request.
 */
import {
  encodeBase64,
  type VoiceConfig,
  type VoiceTranscribeRequestPayload,
  type VoiceTranscribeResponsePayload,
  type VoiceListModelsRequestPayload,
  type VoiceListModelsResponsePayload,
} from '@sumicom/quicksave-shared';
import { getBusForAgent } from './busRegistry';

/** Max raw audio that fits comfortably in a single bus frame (see attachments'
 *  512 KB chunk). Longer recordings are rejected client-side. */
export const MAX_AUDIO_BYTES = 512 * 1024;

/** Below this the recording is effectively empty (silent tap / no mic data);
 *  a near-empty container decodes to 0 seconds and the API rejects it. */
export const MIN_AUDIO_BYTES = 1024;

export class VoiceTranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceTranscriptionError';
  }
}

/** True when voice is configured enough to attempt anything (base URL + at
 *  least one model). Per-path readiness is checked where each path runs. */
export function isVoiceConfigUsable(config: VoiceConfig | null): config is VoiceConfig {
  return !!config && config.baseUrl.trim().length > 0
    && (config.transcribeModel.trim().length > 0 || config.streamModel.trim().length > 0);
}

/**
 * Trim a raw `/models` list down to voice-relevant entries so the picker isn't
 * polluted with chat/embedding/image models. Matches common transcription and
 * realtime naming (whisper, transcribe, realtime, audio). Falls back to the
 * full list if nothing matches — a self-hosted server may name its model
 * arbitrarily, and hiding everything would be worse than a noisy list.
 */
export function filterVoiceModels(ids: string[]): string[] {
  const voice = ids.filter((id) => /whisper|transcrib|realtime|audio/i.test(id));
  return voice.length > 0 ? voice : ids;
}

/** Send a recording to the agent for transcription; returns the text. */
export async function transcribeViaAgent(
  audio: Blob,
  config: VoiceConfig,
  agentId: string,
): Promise<string> {
  if (!isVoiceConfigUsable(config)) {
    throw new VoiceTranscriptionError('Voice transcription is not configured.');
  }
  const bus = getBusForAgent(agentId);
  if (!bus) {
    throw new VoiceTranscriptionError('Not connected to an agent.');
  }
  const bytes = new Uint8Array(await audio.arrayBuffer());
  if (bytes.byteLength < MIN_AUDIO_BYTES) {
    throw new VoiceTranscriptionError('No speech captured — please try again.');
  }
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new VoiceTranscriptionError('Recording is too long. Please record a shorter clip.');
  }
  const res = await bus.command<VoiceTranscribeResponsePayload, VoiceTranscribeRequestPayload>(
    'voice:transcribe',
    { audioBase64: encodeBase64(bytes), mimeType: audio.type || 'audio/webm', config },
    { timeoutMs: 60_000 },
  );
  if (res.error) throw new VoiceTranscriptionError(res.error);
  return res.text;
}

/** Ask the agent to list models from `{baseUrl}/models` for the model picker. */
export async function listModelsViaAgent(config: VoiceConfig, agentId: string): Promise<string[]> {
  const bus = getBusForAgent(agentId);
  if (!bus) {
    throw new VoiceTranscriptionError('Not connected to an agent.');
  }
  const res = await bus.command<VoiceListModelsResponsePayload, VoiceListModelsRequestPayload>(
    'voice:list-models',
    { config },
    { timeoutMs: 30_000 },
  );
  if (res.error) throw new VoiceTranscriptionError(res.error);
  return res.models;
}
