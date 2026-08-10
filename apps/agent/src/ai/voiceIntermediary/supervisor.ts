// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/** Keeps the daemon-facing voice API stable while the intermediary brain runs
 * in a reloadable child process. Durable coding sessions and side effects stay
 * in the daemon; the worker reaches them through a narrow Node IPC bridge. */
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  CardEvent,
  CardStreamEnd,
  ClaudeUserInputRequestPayload,
  VoiceAgentEvent,
  VoiceAgentPlaybackEventRequestPayload,
  VoiceAgentRuntimeStatus,
  VoiceAgentTraceEntry,
  VoiceConfig,
} from '@sumicom/quicksave-shared';
import type { VoiceManagerBridge } from './manager.js';
import type { VoiceTurnMeta } from './session.js';
import type { SynthesizedSpeech } from './tts.js';
import { VoiceDebugStore } from './debugStore.js';
import {
  VOICE_WORKER_PROTOCOL_VERSION,
  type VoiceBridgeRequestFrame,
  type VoiceBridgeResponseFrame,
  type VoiceWorkerCommand,
  type VoiceWorkerCommandFrame,
  type VoiceWorkerOutboundFrame,
  type VoiceWorkerResponseFrame,
} from './workerProtocol.js';

interface Attachment {
  cwd: string;
  config: VoiceConfig;
  clients: Set<string>;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WorkerReady {
  buildId: string;
  instanceId: string;
  pid: number;
  startedAt: number;
}

interface StoredAudio {
  audio: Buffer;
  mimeType: string;
}

const COMMAND_TIMEOUT_MS = 30_000;
const AUDIO_CACHE_CAP = 32;
const WORKER_FILES = /\.(?:ts|js)$/;

export class VoiceIntermediarySupervisor extends EventEmitter {
  private readonly attachments = new Map<string, Attachment>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly audio = new Map<string, StoredAudio>();
  private readonly debugStore: VoiceDebugStore;
  private child: ChildProcess | null = null;
  private starting: Promise<WorkerReady> | null = null;
  private commandSeq = 0;
  private generation = 0;
  private expectedExitGeneration = -1;
  private status: VoiceAgentRuntimeStatus = {
    state: 'stopped',
    protocolVersion: VOICE_WORKER_PROTOCOL_VERSION,
    buildId: 'voice-not-started',
    instanceId: 'none',
    restoredSessionCount: 0,
  };
  private speechSynthesizer: ((sessionId: string, config: VoiceConfig, text: string) => Promise<SynthesizedSpeech | null>) | null = null;

  constructor(private readonly bridge: VoiceManagerBridge, debugStore?: VoiceDebugStore) {
    super();
    this.debugStore = debugStore ?? new VoiceDebugStore();
  }

  setSpeechSynthesizer(
    synthesizer: (sessionId: string, config: VoiceConfig, text: string) => Promise<SynthesizedSpeech | null>,
  ): void {
    this.speechSynthesizer = synthesizer;
  }

  async attach(sessionId: string, config: VoiceConfig, clientId = 'legacy'): Promise<{
    ok: boolean;
    active: boolean;
    runtime: VoiceAgentRuntimeStatus;
    traceHistory: VoiceAgentTraceEntry[];
  }> {
    const cwd = this.bridge.getSessionCwd(sessionId);
    const live = this.bridge.isOpen(sessionId);
    const active = !!config.agentModel?.trim() && !!cwd && live;
    if (!cwd || !live) {
      return {
        ok: true,
        active: false,
        runtime: this.getRuntimeStatus(),
        traceHistory: await this.debugStore.read(sessionId),
      };
    }

    const existing = this.attachments.get(sessionId);
    if (existing) {
      existing.clients.add(clientId);
      existing.config = config;
      existing.cwd = cwd;
    } else {
      this.attachments.set(sessionId, { cwd, config, clients: new Set([clientId]) });
    }
    await this.sendCommand({ method: 'attach', params: { sessionId, cwd, live, config } });
    this.emitRuntime(sessionId);
    return {
      ok: true,
      active,
      runtime: this.getRuntimeStatus(),
      traceHistory: await this.debugStore.read(sessionId),
    };
  }

  detach(sessionId: string, clientId?: string): void {
    const attachment = this.attachments.get(sessionId);
    if (!attachment) return;
    if (clientId) {
      attachment.clients.delete(clientId);
      if (attachment.clients.size > 0) return;
    }
    this.attachments.delete(sessionId);
    if (this.child) void this.sendCommand({ method: 'detach', params: { sessionId } }).catch(() => undefined);
  }

  isAttached(sessionId: string): boolean {
    return this.attachments.has(sessionId);
  }

  async handleUtterance(sessionId: string, text: string, meta: VoiceTurnMeta = {}): Promise<void> {
    if (!this.attachments.has(sessionId)) {
      this.emit('event', sessionId, { kind: 'error', message: '語音同事尚未啟動，請先 attach。' } satisfies VoiceAgentEvent);
      return;
    }
    await this.sendCommand({ method: 'utterance', params: { sessionId, text, meta } });
  }

  recordPlaybackEvent(event: VoiceAgentPlaybackEventRequestPayload): void {
    if (this.child) void this.sendCommand({ method: 'playback', params: event }).catch(() => undefined);
  }

  notifyPendingPermission(request: ClaudeUserInputRequestPayload): void {
    if (!this.attachments.has(request.sessionId)) return;
    void this.sendCommand({ method: 'notify-permission', params: request }).catch(() => undefined);
  }

  recordCardEvent(event: CardEvent): void {
    if (!this.attachments.has(event.sessionId)) return;
    void this.sendCommand({ method: 'card-event', params: event }).catch(() => undefined);
  }

  recordStreamEnd(result: CardStreamEnd): void {
    if (!this.attachments.has(result.sessionId)) return;
    void this.sendCommand({ method: 'stream-end', params: result }).catch(() => undefined);
  }

  notifyStreamEnd(result: CardStreamEnd): void {
    if (!this.attachments.has(result.sessionId)) return;
    void this.sendCommand({ method: 'notify-stream-end', params: result }).catch(() => undefined);
  }

  async getAudio(audioId: string): Promise<{ audio: Buffer; mimeType: string } | null> {
    const cached = this.audio.get(audioId);
    if (cached) return cached;
    const result = await this.sendCommand({ method: 'fetch-audio', params: { audioId } }) as {
      audioBase64?: string;
      mimeType?: string;
    } | null;
    if (!result?.audioBase64) return null;
    return { audio: Buffer.from(result.audioBase64, 'base64'), mimeType: result.mimeType || 'audio/mpeg' };
  }

  getRuntimeStatus(): VoiceAgentRuntimeStatus {
    return { ...this.status };
  }

  async reload(): Promise<VoiceAgentRuntimeStatus> {
    this.setStatus({ state: 'reloading', error: undefined, restoredSessionCount: 0 });
    this.emitRuntime();
    await this.stopWorker();
    const ready = await this.startWorker();
    let restored = 0;
    for (const [sessionId, attachment] of this.attachments) {
      const live = this.bridge.isOpen(sessionId);
      if (!live) continue;
      await this.sendCommand({
        method: 'attach',
        params: { sessionId, cwd: attachment.cwd, live, config: attachment.config },
      });
      restored++;
    }
    this.status = {
      state: 'ready',
      protocolVersion: VOICE_WORKER_PROTOCOL_VERSION,
      ...ready,
      restoredSessionCount: restored,
    };
    this.emitRuntime();
    return this.getRuntimeStatus();
  }

  async close(): Promise<void> {
    await this.stopWorker();
    this.setStatus({ state: 'stopped', pid: undefined, error: undefined, restoredSessionCount: 0 });
  }

  private async ensureWorker(): Promise<WorkerReady> {
    if (this.child && this.status.state === 'ready') {
      return {
        buildId: this.status.buildId,
        instanceId: this.status.instanceId,
        pid: this.status.pid ?? this.child.pid ?? 0,
        startedAt: this.status.startedAt ?? Date.now(),
      };
    }
    return this.startWorker();
  }

  private startWorker(): Promise<WorkerReady> {
    if (this.starting) return this.starting;
    this.setStatus({ state: 'starting', error: undefined, restoredSessionCount: 0 });
    this.emitRuntime();

    const generation = ++this.generation;
    const instanceId = randomUUID();
    const buildId = computeWorkerBuildId();
    const { path, useTsx } = resolveWorkerEntry();
    const child = fork(path, [], {
      cwd: process.cwd(),
      execArgv: useTsx ? ['--import', 'tsx'] : [],
      env: {
        ...process.env,
        QUICKSAVE_VOICE_WORKER_BUILD_ID: buildId,
        QUICKSAVE_VOICE_WORKER_INSTANCE_ID: instanceId,
        QUICKSAVE_VOICE_PARENT_PID: String(process.pid),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    debug(`spawn generation=${generation} pid=${child.pid ?? 'none'} path=${path}`);
    this.child = child;

    this.starting = new Promise<WorkerReady>((resolve, reject) => {
      let settled = false;
      const resolveStartup = (ready: WorkerReady) => {
        if (settled) return;
        settled = true;
        resolve(ready);
      };
      const rejectStartup = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const startupTimer = setTimeout(() => rejectStartup(new Error('voice worker startup timed out')), 15_000);
      child.stderr?.on('data', (chunk) => console.warn(`[voice-worker] ${String(chunk).trimEnd()}`));
      child.on('message', (message) => {
        const frame = message as VoiceWorkerOutboundFrame;
        debug(`message kind=${frame.kind}`);
        if (frame.kind === 'ready') {
          if (frame.protocolVersion !== VOICE_WORKER_PROTOCOL_VERSION) {
            clearTimeout(startupTimer);
            rejectStartup(new Error(`voice worker protocol ${frame.protocolVersion} != ${VOICE_WORKER_PROTOCOL_VERSION}`));
            return;
          }
          clearTimeout(startupTimer);
          const ready = {
            buildId: frame.buildId,
            instanceId: frame.instanceId,
            pid: frame.pid,
            startedAt: frame.startedAt,
          };
          this.status = {
            state: 'ready',
            protocolVersion: VOICE_WORKER_PROTOCOL_VERSION,
            ...ready,
            restoredSessionCount: 0,
          };
          resolveStartup(ready);
          return;
        }
        if (frame.kind === 'response') this.handleResponse(frame);
        else if (frame.kind === 'bridge-request') void this.handleBridgeRequest(frame);
        else if (frame.kind === 'event') this.persistAndEmitWorkerEvent(frame.sessionId, frame.event);
        else if (frame.kind === 'audio') this.storeAudio(frame.audioId, frame.audioBase64, frame.mimeType);
      });

      child.once('error', (error) => {
        debug(`error ${error.message}`);
        clearTimeout(startupTimer);
        rejectStartup(error);
      });
      child.once('exit', (code, signal) => {
        debug(`exit generation=${generation} code=${code} signal=${signal}`);
        clearTimeout(startupTimer);
        if (this.child === child) this.child = null;
        const expected = this.expectedExitGeneration === generation;
        this.rejectPending(new Error(`voice worker exited code=${code ?? 'null'} signal=${signal ?? 'none'}`));
        if (!expected) {
          const message = `Voice worker exited unexpectedly (${code ?? signal ?? 'unknown'}).`;
          this.setStatus({ state: 'failed', pid: undefined, error: message, restoredSessionCount: 0 });
          this.emitRuntime();
        }
        rejectStartup(new Error(`voice worker exited code=${code ?? 'null'} signal=${signal ?? 'none'}`));
      });
    }).finally(() => {
      this.starting = null;
    });

    return this.starting.catch((error) => {
      this.setStatus({ state: 'failed', pid: undefined, error: error.message, restoredSessionCount: 0 });
      this.emitRuntime();
      throw error;
    });
  }

  private async stopWorker(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.expectedExitGeneration = this.generation;
    try {
      await this.sendCommandToReadyChild({ method: 'shutdown', params: {} }, 2_000);
    } catch {
      child.kill('SIGTERM');
    }
    if (this.child === child) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.child === child) child.kill('SIGKILL');
          resolve();
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private async sendCommand(command: VoiceWorkerCommand): Promise<unknown> {
    await this.ensureWorker();
    return this.sendCommandToReadyChild(command, COMMAND_TIMEOUT_MS);
  }

  private sendCommandToReadyChild(command: VoiceWorkerCommand, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error('voice worker is unavailable'));
    const id = `command-${++this.commandSeq}`;
    const frame: VoiceWorkerCommandFrame = { kind: 'command', id, command };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`voice worker command timed out: ${command.method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.send(frame, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private handleResponse(frame: VoiceWorkerResponseFrame): void {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(frame.error ?? 'voice worker command failed'));
  }

  private async handleBridgeRequest(frame: VoiceBridgeRequestFrame): Promise<void> {
    let response: VoiceBridgeResponseFrame;
    try {
      let result: unknown;
      switch (frame.method) {
        case 'sendUserMessageToSession':
          result = await this.bridge.sendUserMessageToSession(...frame.args as Parameters<VoiceManagerBridge['sendUserMessageToSession']>);
          break;
        case 'interruptSession':
          result = await this.bridge.interruptSession(...frame.args as Parameters<VoiceManagerBridge['interruptSession']>);
          break;
        case 'resolveUserInput':
          result = await this.bridge.resolveUserInput(...frame.args as Parameters<VoiceManagerBridge['resolveUserInput']>);
          break;
        case 'setPermissionLevel':
          result = await this.bridge.setPermissionLevel(...frame.args as Parameters<VoiceManagerBridge['setPermissionLevel']>);
          break;
        case 'getCards':
          result = await this.bridge.getCards(...frame.args as Parameters<VoiceManagerBridge['getCards']>);
          break;
        case 'getPendingInputRequests':
          result = await this.bridge.getPendingInputRequests();
          break;
        case 'getPermissionLevel':
          result = await this.bridge.getPermissionLevel(...frame.args as Parameters<VoiceManagerBridge['getPermissionLevel']>);
          break;
        case 'getActiveSessions':
          result = await this.bridge.getActiveSessions();
          break;
        case 'isStreaming':
          result = await this.bridge.isStreaming(...frame.args as Parameters<VoiceManagerBridge['isStreaming']>);
          break;
        case 'synthesizeSpeech': {
          if (!this.speechSynthesizer) throw new Error('voice speech synthesizer is unavailable');
          const [sessionId, config, text] = frame.args as [string, VoiceConfig, string];
          const speech = await this.speechSynthesizer(sessionId, config, text);
          result = speech
            ? {
                audioBase64: speech.audio.toString('base64'),
                mimeType: speech.mimeType,
                requestId: speech.requestId,
                streamed: speech.streamed,
                interrupted: speech.interrupted,
              }
            : null;
          break;
        }
      }
      response = { kind: 'bridge-response', id: frame.id, ok: true, result };
    } catch (error) {
      response = {
        kind: 'bridge-response',
        id: frame.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (this.child?.connected) this.child.send(response);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private storeAudio(audioId: string, audioBase64: string, mimeType: string): void {
    this.audio.set(audioId, { audio: Buffer.from(audioBase64, 'base64'), mimeType });
    while (this.audio.size > AUDIO_CACHE_CAP) {
      const oldest = this.audio.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.audio.delete(oldest);
    }
  }

  private setStatus(patch: Partial<VoiceAgentRuntimeStatus>): void {
    this.status = { ...this.status, ...patch };
  }

  private emitRuntime(onlySessionId?: string): void {
    const event: VoiceAgentEvent = { kind: 'runtime', runtime: this.getRuntimeStatus() };
    if (onlySessionId) {
      this.emit('event', onlySessionId, event);
      this.persistRuntimeTrace(onlySessionId);
      return;
    }
    for (const sessionId of this.attachments.keys()) {
      this.emit('event', sessionId, event);
      this.persistRuntimeTrace(sessionId);
    }
  }

  private persistAndEmitWorkerEvent(sessionId: string, event: VoiceAgentEvent): void {
    if (event.kind === 'trace') {
      const entry = {
        ...event.entry,
        id: `${this.status.instanceId}:${event.entry.id}`,
      };
      void this.debugStore.append(sessionId, entry);
      this.emit('event', sessionId, { kind: 'trace', entry } satisfies VoiceAgentEvent);
      return;
    }
    this.emit('event', sessionId, event);
  }

  private persistRuntimeTrace(sessionId: string): void {
    const attachment = this.attachments.get(sessionId);
    const runtime = this.getRuntimeStatus();
    const entry: VoiceAgentTraceEntry = {
      id: `runtime:${runtime.instanceId}:${runtime.state}:${Date.now()}:${randomUUID()}`,
      timestamp: Date.now(),
      phase: 'lifecycle',
      event: `worker.${runtime.state}`,
      data: {
        model: attachment?.config.agentModel ?? null,
        buildId: runtime.buildId,
        instanceId: runtime.instanceId,
        pid: runtime.pid ?? null,
        protocolVersion: runtime.protocolVersion,
        restoredSessionCount: runtime.restoredSessionCount,
        startedAt: runtime.startedAt ?? null,
        error: runtime.error ?? null,
      },
    };
    void this.debugStore.append(sessionId, entry);
    this.emit('event', sessionId, { kind: 'trace', entry } satisfies VoiceAgentEvent);
  }
}

function resolveWorkerEntry(): { path: string; useTsx: boolean } {
  const source = fileURLToPath(new URL('./worker.ts', import.meta.url));
  if (existsSync(source)) return { path: source, useTsx: true };
  return { path: fileURLToPath(new URL('./worker.js', import.meta.url)), useTsx: false };
}

function computeWorkerBuildId(): string {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const hash = createHash('sha256');
  for (const name of readdirSync(dir).filter((file) => WORKER_FILES.test(file) && !file.includes('.test.')).sort()) {
    hash.update(name);
    hash.update(readFileSync(fileURLToPath(new URL(name, import.meta.url))));
  }
  return `voice-${hash.digest('hex').slice(0, 12)}`;
}

function debug(message: string): void {
  if (process.env.QUICKSAVE_VOICE_WORKER_DEBUG === '1') console.error(`[voice-supervisor] ${message}`);
}
