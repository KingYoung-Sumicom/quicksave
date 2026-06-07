// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * PWA-side client for the voice intermediary ("AI coworker"). Thin wrappers over
 * the `voice-agent:*` bus verbs, mirroring `voiceTranscription.ts`. Speech bytes
 * are fetched by id (metadata-first), never inlined in the push event.
 */
import type {
  VoiceAgentAttachRequestPayload,
  VoiceAgentAttachResponsePayload,
  VoiceAgentDetachRequestPayload,
  VoiceAgentDetachResponsePayload,
  VoiceAgentUtteranceRequestPayload,
  VoiceAgentUtteranceResponsePayload,
  VoiceAgentPlaybackEventRequestPayload,
  VoiceAgentPlaybackEventResponsePayload,
  VoiceAgentFetchAudioRequestPayload,
  VoiceAgentFetchAudioResponsePayload,
  VoiceLogEventRequestPayload,
  VoiceLogEventResponsePayload,
  VoiceConfig,
} from '@sumicom/quicksave-shared';
import { getBusForAgent } from './busRegistry';

/** Bring up (or refresh) the voice agent for a session. */
export async function attachVoiceAgent(
  agentId: string,
  sessionId: string,
  config: VoiceConfig,
): Promise<VoiceAgentAttachResponsePayload> {
  const bus = getBusForAgent(agentId);
  if (!bus) return { ok: false, active: false, error: 'Not connected to an agent.' };
  return bus.command<VoiceAgentAttachResponsePayload, VoiceAgentAttachRequestPayload>(
    'voice-agent:attach',
    { sessionId, config },
    { timeoutMs: 15_000 },
  );
}

/** Tear down the voice agent for a session. Best-effort. */
export async function detachVoiceAgent(agentId: string, sessionId: string): Promise<void> {
  const bus = getBusForAgent(agentId);
  if (!bus) return;
  await bus
    .command<VoiceAgentDetachResponsePayload, VoiceAgentDetachRequestPayload>(
      'voice-agent:detach',
      { sessionId },
      { timeoutMs: 5_000 },
    )
    .catch(() => undefined);
}

/** Deliver a final user utterance (STT transcript). The spoken reply streams
 *  back over `/sessions/:id/voice-agent`, so this only acks receipt. */
export async function sendVoiceAgentUtterance(
  agentId: string,
  sessionId: string,
  text: string,
  meta: Pick<VoiceAgentUtteranceRequestPayload, 'turnId' | 'interactionId' | 'utteranceId'> = {},
): Promise<VoiceAgentUtteranceResponsePayload> {
  const bus = getBusForAgent(agentId);
  if (!bus) return { ok: false, error: 'Not connected to an agent.' };
  return bus.command<VoiceAgentUtteranceResponsePayload, VoiceAgentUtteranceRequestPayload>(
    'voice-agent:utterance',
    { sessionId, text, ...meta },
    { timeoutMs: 10_000 },
  );
}

export function sendVoiceAgentPlaybackEvent(
  agentId: string,
  event: VoiceAgentPlaybackEventRequestPayload,
): void {
  const bus = getBusForAgent(agentId);
  if (!bus) return;
  void bus.command<VoiceAgentPlaybackEventResponsePayload, VoiceAgentPlaybackEventRequestPayload>(
    'voice-agent:playback-event',
    event,
    { timeoutMs: 5_000 },
  ).catch(() => undefined);
}

/** Fetch synthesized speech bytes by id. Returns null when expired/empty. */
export async function fetchVoiceAgentAudio(
  agentId: string,
  sessionId: string,
  audioId: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const bus = getBusForAgent(agentId);
  if (!bus) return null;
  const res = await bus.command<VoiceAgentFetchAudioResponsePayload, VoiceAgentFetchAudioRequestPayload>(
    'voice-agent:fetch-audio',
    { sessionId, audioId },
    { timeoutMs: 15_000 },
  );
  if (!res.audioBase64) return null;
  return { bytes: decodeBase64(res.audioBase64), mimeType: res.mimeType || 'audio/mpeg' };
}

export function logVoiceEvent(
  agentId: string,
  event: VoiceLogEventRequestPayload,
): void {
  const bus = getBusForAgent(agentId);
  if (!bus) return;
  void bus.command<VoiceLogEventResponsePayload, VoiceLogEventRequestPayload>(
    'voice:log-event',
    event,
    { timeoutMs: 5_000 },
  ).catch(() => undefined);
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
