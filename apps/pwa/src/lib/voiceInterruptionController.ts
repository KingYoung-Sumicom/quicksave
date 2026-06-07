// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

export type VoiceInterruptionEvent =
  | { type: 'agent_speech_started'; audioId?: string }
  | { type: 'agent_speech_ended'; audioId?: string }
  | { type: 'agent_speech_interrupted'; audioId?: string }
  | { type: 'agent_speech_unavailable'; audioId?: string }
  | { type: 'agent_thinking_started' }
  | { type: 'agent_response_ready'; audioId?: string }
  | { type: 'agent_idle' }
  | { type: 'user_speech_started'; nowMs?: number }
  | { type: 'user_speech_stopped'; nowMs?: number }
  | { type: 'intent_grace_started' }
  | { type: 'intent_committed' }
  | { type: 'intent_cancelled'; reason?: string }
  | { type: 'transcript_partial'; textChars: number; nowMs?: number }
  | { type: 'transcript_final'; textChars: number; nowMs?: number };

export type VoiceInterruptionAction =
  | { type: 'log'; event: string; turnId?: string; data?: Record<string, unknown> }
  | { type: 'interrupt_agent_speech'; reason: string; turnId?: string; snapshot?: VoiceInterruptionSnapshot }
  | { type: 'cancel_pending_commit'; reason: string }
  | { type: 'resume_agent_speech'; reason: string };

export interface VoiceInterruptionSnapshot {
  interactionId?: string;
  utteranceId?: string;
  phase: VoiceInteractionPhase;
  agentSpeaking: boolean;
  userSpeaking: boolean;
  suppressTranscript: boolean;
  currentAudioId?: string;
}

export type VoiceInteractionPhase =
  | 'idle'
  | 'listening'
  | 'user_speaking'
  | 'endpoint_grace'
  | 'committing'
  | 'agent_thinking'
  | 'tts_waiting'
  | 'assistant_speaking';

export interface VoiceInterruptionLogContext {
  turnId?: string;
  data?: Record<string, unknown>;
}

export interface VoiceInterruptionControllerOptions {
  idFactory?: () => string;
  minBargeInTranscriptChars?: number;
  pendingBargeInTranscriptGraceMs?: number;
}

/**
 * Pure voice-interruption state machine.
 *
 * It intentionally has no timers, React state, audio element access, or mic
 * access. Hooks feed it speech/playback events and execute returned actions.
 * This keeps LiveKit-style interruption behavior testable before we enable
 * richer barge-in / false-interruption policies.
 */
export class VoiceInterruptionController {
  private phase: VoiceInteractionPhase = 'idle';
  private agentSpeaking = false;
  private userSpeaking = false;
  private agentAudioPending = false;
  private currentAudioId: string | undefined;
  private interactionId: string | undefined;
  private utteranceId: string | undefined;
  private pendingBargeIn:
    | { audioId?: string; wasSpeaking: boolean; wasPending: boolean; expiresAtMs?: number }
    | undefined;
  private nextId = 1;

  constructor(private readonly opts: VoiceInterruptionControllerOptions = {}) {}

  handle(event: VoiceInterruptionEvent): VoiceInterruptionAction[] {
    switch (event.type) {
      case 'agent_speech_started':
        this.transition('assistant_speaking');
        this.agentSpeaking = true;
        this.agentAudioPending = false;
        this.currentAudioId = event.audioId;
        return [this.logAction('agent_speech.start', this.audioData(event.audioId))];

      case 'agent_speech_ended':
        this.agentSpeaking = false;
        this.agentAudioPending = false;
        this.currentAudioId = undefined;
        this.pendingBargeIn = undefined;
        this.transition(this.userSpeaking ? 'user_speaking' : 'listening');
        const endedLog = this.logAction('agent_speech.end', this.audioData(event.audioId));
        const endedStateLog = this.stateLog('agent_speech_ended');
        this.clearTurnIfSettled();
        return [
          endedLog,
          endedStateLog,
        ];

      case 'agent_speech_interrupted':
        this.agentSpeaking = false;
        this.agentAudioPending = false;
        this.currentAudioId = undefined;
        this.pendingBargeIn = undefined;
        this.transition(this.userSpeaking ? 'user_speaking' : 'listening');
        const interruptedLog = this.logAction('agent_speech.interrupted', this.audioData(event.audioId));
        const interruptedStateLog = this.stateLog('agent_speech_interrupted');
        this.clearTurnIfSettled();
        return [
          interruptedLog,
          interruptedStateLog,
        ];

      case 'agent_speech_unavailable':
        this.agentSpeaking = false;
        this.agentAudioPending = false;
        this.currentAudioId = undefined;
        this.pendingBargeIn = undefined;
        this.transition(this.userSpeaking ? 'user_speaking' : 'listening');
        const unavailableLog = this.logAction('agent_speech.unavailable', this.audioData(event.audioId));
        const unavailableStateLog = this.stateLog('agent_speech_unavailable');
        this.clearTurnIfSettled();
        return [
          unavailableLog,
          unavailableStateLog,
        ];

      case 'agent_thinking_started':
        this.transition('agent_thinking');
        return [this.stateLog('agent_thinking_started')];

      case 'agent_response_ready':
        this.agentAudioPending = !!event.audioId;
        this.currentAudioId = event.audioId;
        this.transition(event.audioId ? 'tts_waiting' : 'listening');
        return [this.stateLog('agent_response_ready')];

      case 'agent_idle':
        if (!this.agentSpeaking && !this.agentAudioPending) this.transition(this.userSpeaking ? 'user_speaking' : 'listening');
        const idleStateLog = this.stateLog('agent_idle');
        this.clearTurnIfSettled();
        return [idleStateLog];

      case 'user_speech_started':
        this.ensureTurnIds();
        this.userSpeaking = true;
        this.transition('user_speaking');
        if (this.agentSpeaking || this.agentAudioPending) {
          const audioId = this.currentAudioId;
          const wasSpeaking = this.agentSpeaking;
          const wasPending = this.agentAudioPending;
          this.pendingBargeIn = { audioId, wasSpeaking, wasPending };
          return [
            this.logAction('barge_in.candidate', {
              overlap: wasSpeaking,
              pendingAudio: wasPending,
              ...this.audioData(audioId),
              snapshot: this.snapshot(),
            }),
            { type: 'cancel_pending_commit', reason: 'speech_activity' },
            this.stateLog('user_speech_started'),
          ];
        }
        return [
          this.logAction('user_speech.start', { snapshot: this.snapshot() }),
          { type: 'cancel_pending_commit', reason: 'speech_activity' },
          this.stateLog('user_speech_started'),
        ];

      case 'user_speech_stopped':
        this.userSpeaking = false;
        if (this.pendingBargeIn) {
          this.transition(this.agentAudioPending ? 'tts_waiting' : this.agentSpeaking ? 'assistant_speaking' : 'listening');
          this.pendingBargeIn.expiresAtMs = this.now(event) + (this.opts.pendingBargeInTranscriptGraceMs ?? 1500);
        } else {
          this.transition(this.agentSpeaking ? 'assistant_speaking' : 'listening');
        }
        return [
          this.logAction('user_speech.stop', { overlap: this.agentSpeaking, snapshot: this.snapshot() }),
          this.stateLog('user_speech_stopped'),
        ];

      case 'intent_grace_started':
        this.transition('endpoint_grace');
        return [this.stateLog('intent_grace_started')];

      case 'intent_committed':
        this.transition('committing');
        return [this.stateLog('intent_committed')];

      case 'intent_cancelled':
        this.transition(this.userSpeaking ? 'user_speaking' : 'listening');
        return [this.stateLog(event.reason ?? 'intent_cancelled')];

      case 'transcript_partial':
        if (this.pendingBargeIn && this.pendingBargeInExpired(this.now(event))) {
          this.pendingBargeIn = undefined;
        }
        if (this.pendingBargeIn && this.bargeInTranscriptConfirmed(event.textChars)) {
          return this.confirmBargeIn('transcript_partial', event.textChars);
        }
        if (this.shouldSuppressTranscript()) {
          return [this.logAction('transcript.partial_suppressed', { textChars: event.textChars, snapshot: this.snapshot() })];
        }
        return [];

      case 'transcript_final':
        if (this.pendingBargeIn && this.pendingBargeInExpired(this.now(event))) {
          this.pendingBargeIn = undefined;
        }
        if (this.pendingBargeIn && this.bargeInTranscriptConfirmed(event.textChars)) {
          return this.confirmBargeIn('transcript_final', event.textChars);
        }
        if (this.shouldSuppressTranscript()) {
          return [this.logAction('transcript.final_suppressed', { textChars: event.textChars, snapshot: this.snapshot() })];
        }
        return [];
    }
  }

  shouldSuppressTranscript(): boolean {
    return this.agentSpeaking;
  }

  snapshot(): VoiceInterruptionSnapshot {
    return {
      interactionId: this.interactionId,
      utteranceId: this.utteranceId,
      phase: this.phase,
      agentSpeaking: this.agentSpeaking,
      userSpeaking: this.userSpeaking,
      suppressTranscript: this.shouldSuppressTranscript(),
      currentAudioId: this.currentAudioId,
    };
  }

  reset(): void {
    this.phase = 'idle';
    this.agentSpeaking = false;
    this.userSpeaking = false;
    this.agentAudioPending = false;
    this.currentAudioId = undefined;
    this.interactionId = undefined;
    this.utteranceId = undefined;
    this.pendingBargeIn = undefined;
  }

  logContext(): VoiceInterruptionLogContext {
    const data = this.interactionId || this.utteranceId
      ? { interactionId: this.interactionId, utteranceId: this.utteranceId }
      : undefined;
    return { turnId: this.utteranceId, data };
  }

  private transition(next: VoiceInteractionPhase): void {
    if (this.phase === next) return;
    this.phase = next;
  }

  private stateLog(reason: string): VoiceInterruptionAction {
    return this.logAction('voice_interaction.state', { reason, snapshot: this.snapshot() });
  }

  private audioData(audioId: string | undefined): Record<string, unknown> | undefined {
    return audioId ? { audioId } : undefined;
  }

  private logAction(event: string, data?: Record<string, unknown>): VoiceInterruptionAction {
    return {
      type: 'log',
      event,
      turnId: this.utteranceId,
      data: {
        ...(this.interactionId ? { interactionId: this.interactionId } : {}),
        ...(this.utteranceId ? { utteranceId: this.utteranceId } : {}),
        ...(data ?? {}),
      },
    };
  }

  private ensureTurnIds(): void {
    if (this.utteranceId) return;
    const id = this.opts.idFactory?.() ?? `voice-turn-${this.nextId++}`;
    this.interactionId = id;
    this.utteranceId = id;
  }

  private clearTurnIfSettled(): void {
    if (this.userSpeaking || this.agentSpeaking || this.agentAudioPending) return;
    if (this.phase !== 'listening' && this.phase !== 'idle') return;
    this.interactionId = undefined;
    this.utteranceId = undefined;
  }

  private bargeInTranscriptConfirmed(textChars: number): boolean {
    return textChars >= (this.opts.minBargeInTranscriptChars ?? 1);
  }

  private pendingBargeInExpired(nowMs: number): boolean {
    return this.pendingBargeIn?.expiresAtMs != null && nowMs > this.pendingBargeIn.expiresAtMs;
  }

  private now(event: { nowMs?: number }): number {
    return event.nowMs ?? Date.now();
  }

  private confirmBargeIn(reason: string, textChars: number): VoiceInterruptionAction[] {
    const pending = this.pendingBargeIn;
    if (!pending) return [];
    this.pendingBargeIn = undefined;
    this.agentSpeaking = false;
    this.agentAudioPending = false;
    this.currentAudioId = undefined;
    this.transition(this.userSpeaking ? 'user_speaking' : 'listening');
    return [
      this.logAction('barge_in.confirmed', {
        reason,
        textChars,
        overlap: pending.wasSpeaking,
        pendingAudio: pending.wasPending,
        ...this.audioData(pending.audioId),
        snapshot: this.snapshot(),
      }),
      { type: 'interrupt_agent_speech', reason, turnId: this.utteranceId, snapshot: this.snapshot() },
      this.stateLog(reason),
    ];
  }
}
