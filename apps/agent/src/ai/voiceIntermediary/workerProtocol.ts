// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import type {
  CardEvent,
  CardStreamEnd,
  ClaudeUserInputRequestPayload,
  VoiceAgentEvent,
  VoiceAgentPlaybackEventRequestPayload,
  VoiceConfig,
} from '@sumicom/quicksave-shared';
import type { VoiceTurnMeta } from './session.js';

export const VOICE_WORKER_PROTOCOL_VERSION = 2;

export type VoiceWorkerCommand =
  | { method: 'attach'; params: { sessionId: string; cwd: string; live: boolean; config: VoiceConfig } }
  | { method: 'detach'; params: { sessionId: string } }
  | { method: 'utterance'; params: { sessionId: string; text: string; meta: VoiceTurnMeta } }
  | { method: 'playback'; params: VoiceAgentPlaybackEventRequestPayload }
  | { method: 'card-event'; params: CardEvent }
  | { method: 'stream-end'; params: CardStreamEnd }
  | { method: 'notify-stream-end'; params: CardStreamEnd }
  | { method: 'notify-permission'; params: ClaudeUserInputRequestPayload }
  | { method: 'fetch-audio'; params: { audioId: string } }
  | { method: 'shutdown'; params: Record<string, never> };

export interface VoiceWorkerCommandFrame {
  kind: 'command';
  id: string;
  command: VoiceWorkerCommand;
}

export interface VoiceWorkerResponseFrame {
  kind: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface VoiceWorkerReadyFrame {
  kind: 'ready';
  protocolVersion: number;
  buildId: string;
  instanceId: string;
  pid: number;
  startedAt: number;
}

export interface VoiceWorkerEventFrame {
  kind: 'event';
  sessionId: string;
  event: VoiceAgentEvent;
}

export interface VoiceWorkerAudioFrame {
  kind: 'audio';
  audioId: string;
  audioBase64: string;
  mimeType: string;
}

export type VoiceBridgeMethod =
  | 'sendUserMessageToSession'
  | 'interruptSession'
  | 'resolveUserInput'
  | 'setPermissionLevel'
  | 'getCards'
  | 'getPendingInputRequests'
  | 'getPermissionLevel'
  | 'getActiveSessions'
  | 'isStreaming'
  | 'synthesizeSpeech';

export interface VoiceBridgeRequestFrame {
  kind: 'bridge-request';
  id: string;
  method: VoiceBridgeMethod;
  args: unknown[];
}

export interface VoiceBridgeResponseFrame {
  kind: 'bridge-response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type VoiceWorkerInboundFrame = VoiceWorkerCommandFrame | VoiceBridgeResponseFrame;
export type VoiceWorkerOutboundFrame =
  | VoiceWorkerReadyFrame
  | VoiceWorkerResponseFrame
  | VoiceWorkerEventFrame
  | VoiceWorkerAudioFrame
  | VoiceBridgeRequestFrame;
