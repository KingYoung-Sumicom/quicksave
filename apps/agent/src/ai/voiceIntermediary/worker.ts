// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/** Reloadable voice-intermediary worker. Messages use Node's dedicated IPC
 * channel so normal stdout/stderr diagnostics cannot corrupt protocol frames. */
import type {
  CardHistoryResponse,
  ClaudeUserInputRequestPayload,
  ClaudeUserInputResponsePayload,
} from '@sumicom/quicksave-shared';
import { randomUUID } from 'node:crypto';
import { VoiceIntermediaryManager, type VoiceManagerBridge } from './manager.js';
import type { SynthesizedSpeech } from './tts.js';
import {
  VOICE_WORKER_PROTOCOL_VERSION,
  type VoiceBridgeMethod,
  type VoiceBridgeRequestFrame,
  type VoiceBridgeResponseFrame,
  type VoiceWorkerCommandFrame,
  type VoiceWorkerInboundFrame,
  type VoiceWorkerOutboundFrame,
} from './workerProtocol.js';

interface PendingBridgeCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class RemoteCodingBridge implements VoiceManagerBridge {
  private readonly sessionMeta = new Map<string, { cwd: string; live: boolean }>();
  private readonly pending = new Map<string, PendingBridgeCall>();
  private seq = 0;

  setSession(sessionId: string, cwd: string, live: boolean): void {
    this.sessionMeta.set(sessionId, { cwd, live });
  }

  removeSession(sessionId: string): void {
    this.sessionMeta.delete(sessionId);
  }

  getSessionCwd(sessionId: string): string | undefined {
    return this.sessionMeta.get(sessionId)?.cwd;
  }

  isOpen(sessionId: string): boolean {
    return this.sessionMeta.get(sessionId)?.live ?? false;
  }

  sendUserMessageToSession(sessionId: string, prompt: string, opts?: { interrupt?: boolean }): Promise<boolean> {
    return this.call('sendUserMessageToSession', [sessionId, prompt, opts]) as Promise<boolean>;
  }

  interruptSession(sessionId: string): Promise<boolean> {
    return this.call('interruptSession', [sessionId]) as Promise<boolean>;
  }

  resolveUserInput(response: ClaudeUserInputResponsePayload): Promise<boolean> {
    return this.call('resolveUserInput', [response]) as Promise<boolean>;
  }

  setPermissionLevel(sessionId: string, level: string): Promise<boolean> {
    return this.call('setPermissionLevel', [sessionId, level]) as Promise<boolean>;
  }

  getCards(sessionId: string, cwd: string, offset?: number, limit?: number): Promise<CardHistoryResponse> {
    return this.call('getCards', [sessionId, cwd, offset, limit]) as Promise<CardHistoryResponse>;
  }

  getPendingInputRequests(): Promise<ClaudeUserInputRequestPayload[]> {
    return this.call('getPendingInputRequests', []) as Promise<ClaudeUserInputRequestPayload[]>;
  }

  getPermissionLevel(sessionId: string): Promise<string> {
    return this.call('getPermissionLevel', [sessionId]) as Promise<string>;
  }

  getActiveSessions(): Promise<Array<{ sessionId: string; isStreaming?: boolean; hasPendingInput?: boolean; permissionMode?: string }>> {
    return this.call('getActiveSessions', []) as Promise<Array<{ sessionId: string; isStreaming?: boolean; hasPendingInput?: boolean; permissionMode?: string }>>;
  }

  isStreaming(sessionId: string): Promise<boolean> {
    return this.call('isStreaming', [sessionId]) as Promise<boolean>;
  }

  async synthesizeSpeech(sessionId: string, config: import('@sumicom/quicksave-shared').VoiceConfig, text: string): Promise<SynthesizedSpeech | null> {
    const result = await this.call('synthesizeSpeech', [sessionId, config, text]) as {
      audioBase64: string;
      mimeType: string;
      requestId?: string;
      streamed?: boolean;
      interrupted?: boolean;
    } | null;
    if (!result) return null;
    return {
      audio: Buffer.from(result.audioBase64, 'base64'),
      mimeType: result.mimeType,
      requestId: result.requestId,
      streamed: result.streamed,
      interrupted: result.interrupted,
    };
  }

  handleResponse(frame: VoiceBridgeResponseFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(frame.error ?? 'voice bridge request failed'));
  }

  rejectAll(reason: Error): void {
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }

  private call(method: VoiceBridgeMethod, args: unknown[]): Promise<unknown> {
    const id = `bridge-${++this.seq}`;
    const frame: VoiceBridgeRequestFrame = { kind: 'bridge-request', id, method, args };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      send(frame);
    });
  }
}

const buildId = process.env.QUICKSAVE_VOICE_WORKER_BUILD_ID ?? 'voice-unknown';
const instanceId = process.env.QUICKSAVE_VOICE_WORKER_INSTANCE_ID ?? `voice-worker-${process.pid}`;
const parentPid = Number(process.env.QUICKSAVE_VOICE_PARENT_PID ?? process.ppid);
const startedAt = Date.now();
const bridge = new RemoteCodingBridge();
const manager = new VoiceIntermediaryManager(bridge, undefined, (audio, mimeType) => {
  const audioId = randomUUID();
  send({ kind: 'audio', audioId, audioBase64: audio.toString('base64'), mimeType });
  return audioId;
}, (sessionId, config, text) => bridge.synthesizeSpeech(sessionId, config, text));
const attached = new Set<string>();

manager.on('event', (sessionId, event) => {
  send({ kind: 'event', sessionId, event });
});

function send(frame: VoiceWorkerOutboundFrame): void {
  process.send?.(frame);
}

async function handleCommand(frame: VoiceWorkerCommandFrame): Promise<void> {
  const { command } = frame;
  try {
    let result: unknown;
    switch (command.method) {
      case 'attach':
        bridge.setSession(command.params.sessionId, command.params.cwd, command.params.live);
        attached.add(command.params.sessionId);
        result = manager.attach(command.params.sessionId, command.params.config);
        break;
      case 'detach':
        manager.detach(command.params.sessionId);
        bridge.removeSession(command.params.sessionId);
        attached.delete(command.params.sessionId);
        result = { ok: true };
        break;
      case 'utterance':
        await manager.handleUtterance(command.params.sessionId, command.params.text, command.params.meta);
        result = { ok: true };
        break;
      case 'playback':
        manager.recordPlaybackEvent(command.params);
        result = { ok: true };
        break;
      case 'card-event':
        manager.recordCardEvent(command.params);
        result = { ok: true };
        break;
      case 'stream-end':
        manager.recordStreamEnd(command.params);
        result = { ok: true };
        break;
      case 'notify-stream-end':
        manager.notifyStreamEnd(command.params);
        result = { ok: true };
        break;
      case 'notify-permission':
        manager.notifyPendingPermission(command.params);
        result = { ok: true };
        break;
      case 'fetch-audio': {
        const stored = manager.getAudio(command.params.audioId);
        result = stored
          ? { audioBase64: stored.audio.toString('base64'), mimeType: stored.mimeType }
          : null;
        break;
      }
      case 'shutdown':
        for (const sessionId of attached) manager.detach(sessionId);
        attached.clear();
        result = { ok: true };
        send({ kind: 'response', id: frame.id, ok: true, result });
        setImmediate(() => process.exit(0));
        return;
    }
    send({ kind: 'response', id: frame.id, ok: true, result });
  } catch (error) {
    send({
      kind: 'response',
      id: frame.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

process.on('message', (message) => {
  const frame = message as VoiceWorkerInboundFrame;
  if (frame.kind === 'bridge-response') bridge.handleResponse(frame);
  else if (frame.kind === 'command') void handleCommand(frame);
});
process.on('disconnect', () => {
  bridge.rejectAll(new Error('voice worker input closed'));
  process.exit(0);
});

const parentWatch = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    process.exit(0);
  }
}, 1_000);
parentWatch.unref();

send({
  kind: 'ready',
  protocolVersion: VOICE_WORKER_PROTOCOL_VERSION,
  buildId,
  instanceId,
  pid: process.pid,
  startedAt,
});
