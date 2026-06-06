// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * Owns the per-session voice intermediaries and bridges them to the rest of the
 * daemon. Emits a single `'event'` (sessionId, VoiceAgentEvent) that `run.ts`
 * republishes on `/sessions/:sessionId/voice-agent`. Holds synthesized audio in
 * a small LRU so the PWA can fetch bytes by id (metadata-first delivery).
 */
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  ClaudeUserInputRequestPayload,
  VoiceAgentEvent,
  VoiceConfig,
} from '@sumicom/quicksave-shared';
import type { FetchLike } from './llm.js';
import type { CodingSessionBridge } from './tools.js';
import { VoiceIntermediarySession } from './session.js';

/** The SessionManager surface the manager needs, beyond the tool bridge. */
export type VoiceManagerBridge = CodingSessionBridge & {
  getSessionCwd(sessionId: string): string | undefined;
  isOpen(sessionId: string): boolean;
};

interface StoredAudio {
  audio: Buffer;
  mimeType: string;
}

/** Keep at most this many recent utterances of audio addressable for fetch. */
const AUDIO_CACHE_CAP = 32;

export class VoiceIntermediaryManager extends EventEmitter {
  private readonly sessions = new Map<string, VoiceIntermediarySession>();
  private readonly audio = new Map<string, StoredAudio>();

  constructor(
    private readonly bridge: VoiceManagerBridge,
    /** Injected for tests. */
    private readonly fetchImpl?: FetchLike,
  ) {
    super();
  }

  /**
   * Attach (or refresh) the voice agent for a coding session. `active` is true
   * only when a brain model is configured and the session is live — i.e. the
   * agent will actually respond. Attaching an idle/mis-configured session is a
   * no-op that reports `active:false` rather than erroring.
   */
  attach(sessionId: string, config: VoiceConfig): { ok: boolean; active: boolean } {
    const cwd = this.bridge.getSessionCwd(sessionId);
    const live = this.bridge.isOpen(sessionId);
    const active = !!config.agentModel?.trim() && !!cwd && live;
    if (!cwd || !live) return { ok: true, active: false };

    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.updateConfig(config, cwd);
      return { ok: true, active };
    }

    const session = new VoiceIntermediarySession({
      sessionId,
      cwd,
      config,
      bridge: this.bridge,
      fetchImpl: this.fetchImpl,
      callbacks: {
        emit: (event) => this.emitEvent(sessionId, event),
        storeAudio: (a, mime) => this.storeAudio(a, mime),
      },
    });
    this.sessions.set(sessionId, session);
    return { ok: true, active };
  }

  detach(sessionId: string): void {
    this.sessions.get(sessionId)?.close();
    this.sessions.delete(sessionId);
  }

  isAttached(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async handleUtterance(sessionId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.emitEvent(sessionId, { kind: 'error', message: '語音同事尚未啟動，請先 attach。' });
      return;
    }
    if (!session.hasBrain()) {
      this.emitEvent(sessionId, { kind: 'error', message: '尚未設定語音 agent 模型（agentModel）。' });
      return;
    }
    await session.handleUtterance(trimmed);
  }

  /**
   * Proactively nudge the agent when the coding side raises a permission prompt,
   * so it can narrate "it wants to run X — shall I allow it?" without the user
   * having to ask. No-op when no agent is attached to that session.
   */
  notifyPendingPermission(request: ClaudeUserInputRequestPayload): void {
    const session = this.sessions.get(request.sessionId);
    if (!session || !session.hasBrain()) return;
    const tool = request.toolName ?? request.title;
    const detail = request.toolInput ? ` 內容：${safeBrief(request.toolInput)}` : '';
    void session.notify(
      `coding agent 要權限執行「${tool}」。${detail} 這可能不可逆，先別自己決定——用講的說明並詢問使用者，得到口頭同意再用 respond_to_permission 回覆（request_id：${request.requestId}）。`,
    );
  }

  getAudio(audioId: string): StoredAudio | null {
    return this.audio.get(audioId) ?? null;
  }

  private storeAudio(audio: Buffer, mimeType: string): string {
    const id = randomUUID();
    this.audio.set(id, { audio, mimeType });
    while (this.audio.size > AUDIO_CACHE_CAP) {
      const oldest = this.audio.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.audio.delete(oldest);
    }
    return id;
  }

  private emitEvent(sessionId: string, event: VoiceAgentEvent): void {
    this.emit('event', sessionId, event);
  }
}

function safeBrief(input: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return '';
  }
}
