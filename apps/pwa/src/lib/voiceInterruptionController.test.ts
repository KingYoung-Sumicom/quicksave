// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { VoiceInterruptionController } from './voiceInterruptionController';

describe('VoiceInterruptionController', () => {
  it('suppresses transcript while agent speech is playing and allows it afterward', () => {
    const c = new VoiceInterruptionController();

    expect(c.shouldSuppressTranscript()).toBe(false);
    expect(c.handle({ type: 'agent_speech_started', audioId: 'a1' })).toEqual([
      { type: 'log', event: 'agent_speech.start', data: { audioId: 'a1' } },
    ]);
    expect(c.shouldSuppressTranscript()).toBe(true);
    expect(c.handle({ type: 'transcript_partial', textChars: 5 })).toEqual([
      {
        type: 'log',
        event: 'transcript.partial_suppressed',
        data: {
          textChars: 5,
          snapshot: expect.objectContaining({ phase: 'assistant_speaking', suppressTranscript: true }),
        },
      },
    ]);
    expect(c.handle({ type: 'transcript_final', textChars: 9 })).toEqual([
      {
        type: 'log',
        event: 'transcript.final_suppressed',
        data: {
          textChars: 9,
          snapshot: expect.objectContaining({ phase: 'assistant_speaking', suppressTranscript: true }),
        },
      },
    ]);

    expect(c.handle({ type: 'agent_speech_ended', audioId: 'a1' })).toContainEqual(
      { type: 'log', event: 'agent_speech.end', data: { audioId: 'a1' } },
    );
    expect(c.shouldSuppressTranscript()).toBe(false);
    expect(c.handle({ type: 'transcript_partial', textChars: 5 })).toEqual([]);
  });

  it('marks a barge-in candidate on user speech start, then interrupts after transcript arrives', () => {
    const c = new VoiceInterruptionController();
    c.handle({ type: 'agent_speech_started' });

    const actions = c.handle({ type: 'user_speech_started' });
    expect(actions).toContainEqual(expect.objectContaining({
      type: 'log',
      event: 'barge_in.candidate',
      data: expect.objectContaining({
        overlap: true,
        pendingAudio: false,
        snapshot: expect.objectContaining({ phase: 'user_speaking', suppressTranscript: true }),
      }),
    }));
    expect(actions).toContainEqual({ type: 'cancel_pending_commit', reason: 'speech_activity' });
    expect(actions.some((a) => a.type === 'interrupt_agent_speech')).toBe(false);
    expect(c.snapshot()).toMatchObject({
      phase: 'user_speaking',
      agentSpeaking: true,
      userSpeaking: true,
      suppressTranscript: true,
    });

    const confirmed = c.handle({ type: 'transcript_partial', textChars: 2 });
    expect(confirmed).toContainEqual(expect.objectContaining({
      type: 'interrupt_agent_speech',
      reason: 'transcript_partial',
      snapshot: expect.objectContaining({ phase: 'user_speaking', suppressTranscript: false }),
    }));
    expect(c.snapshot()).toMatchObject({
      phase: 'user_speaking',
      agentSpeaking: false,
      userSpeaking: true,
      suppressTranscript: false,
    });

    expect(c.handle({ type: 'user_speech_stopped' })).toContainEqual(
      {
        type: 'log',
        event: 'user_speech.stop',
        turnId: 'voice-turn-1',
        data: expect.objectContaining({ overlap: false }),
      },
    );
    expect(c.snapshot().userSpeaking).toBe(false);
  });

  it('does not interrupt agent speech for a short speech blip with no transcript', () => {
    const c = new VoiceInterruptionController();
    c.handle({ type: 'agent_speech_started', audioId: 'a1' });
    c.handle({ type: 'user_speech_started' });

    const stopped = c.handle({ type: 'user_speech_stopped' });

    expect(stopped.some((a) => a.type === 'interrupt_agent_speech')).toBe(false);
    expect(c.snapshot()).toMatchObject({
      phase: 'assistant_speaking',
      agentSpeaking: true,
      userSpeaking: false,
      suppressTranscript: true,
      currentAudioId: 'a1',
    });
  });

  it('confirms barge-in when transcript arrives after speech already stopped', () => {
    const c = new VoiceInterruptionController({ pendingBargeInTranscriptGraceMs: 1500 });
    c.handle({ type: 'agent_speech_started', audioId: 'a1' });
    c.handle({ type: 'user_speech_started', nowMs: 1000 });
    c.handle({ type: 'user_speech_stopped', nowMs: 1300 });

    const confirmed = c.handle({ type: 'transcript_final', textChars: 4, nowMs: 1800 });

    expect(confirmed).toContainEqual(expect.objectContaining({
      type: 'interrupt_agent_speech',
      reason: 'transcript_final',
      snapshot: expect.objectContaining({
        phase: 'listening',
        agentSpeaking: false,
        suppressTranscript: false,
      }),
    }));
    expect(c.snapshot()).toMatchObject({
      phase: 'listening',
      agentSpeaking: false,
      suppressTranscript: false,
    });
  });

  it('expires a stopped barge-in candidate if transcript arrives too late', () => {
    const c = new VoiceInterruptionController({ pendingBargeInTranscriptGraceMs: 500 });
    c.handle({ type: 'agent_speech_started', audioId: 'a1' });
    c.handle({ type: 'user_speech_started', nowMs: 1000 });
    c.handle({ type: 'user_speech_stopped', nowMs: 1100 });

    const late = c.handle({ type: 'transcript_final', textChars: 4, nowMs: 1701 });

    expect(late.some((a) => a.type === 'interrupt_agent_speech')).toBe(false);
    expect(late).toContainEqual(expect.objectContaining({
      type: 'log',
      event: 'transcript.final_suppressed',
    }));
    expect(c.snapshot()).toMatchObject({
      phase: 'assistant_speaking',
      agentSpeaking: true,
      suppressTranscript: true,
    });
  });

  it('clears suppression when agent speech is interrupted or unavailable', () => {
    const c = new VoiceInterruptionController();

    c.handle({ type: 'agent_speech_started', audioId: 'a1' });
    expect(c.handle({ type: 'agent_speech_interrupted', audioId: 'a1' })).toContainEqual(
      { type: 'log', event: 'agent_speech.interrupted', data: { audioId: 'a1' } },
    );
    expect(c.shouldSuppressTranscript()).toBe(false);

    c.handle({ type: 'agent_speech_started', audioId: 'a2' });
    expect(c.handle({ type: 'agent_speech_unavailable', audioId: 'a2' })).toContainEqual(
      { type: 'log', event: 'agent_speech.unavailable', data: { audioId: 'a2' } },
    );
    expect(c.snapshot()).toMatchObject({
      phase: 'listening',
      agentSpeaking: false,
      userSpeaking: false,
      suppressTranscript: false,
    });
  });

  it('tracks the LiveKit-like voice turn phases', () => {
    const c = new VoiceInterruptionController();

    c.handle({ type: 'user_speech_started' });
    expect(c.snapshot().phase).toBe('user_speaking');

    c.handle({ type: 'user_speech_stopped' });
    expect(c.snapshot().phase).toBe('listening');

    c.handle({ type: 'intent_grace_started' });
    expect(c.snapshot().phase).toBe('endpoint_grace');

    c.handle({ type: 'intent_committed' });
    expect(c.snapshot().phase).toBe('committing');

    c.handle({ type: 'agent_thinking_started' });
    expect(c.snapshot().phase).toBe('agent_thinking');

    c.handle({ type: 'agent_response_ready', audioId: 'a1' });
    expect(c.snapshot().phase).toBe('tts_waiting');

    c.handle({ type: 'agent_speech_started', audioId: 'a1' });
    expect(c.snapshot().phase).toBe('assistant_speaking');

    c.handle({ type: 'agent_speech_ended', audioId: 'a1' });
    expect(c.snapshot().phase).toBe('listening');
  });

  it('keeps tts_waiting across backend idle until playback starts or user barges in', () => {
    const c = new VoiceInterruptionController();

    c.handle({ type: 'agent_response_ready', audioId: 'a1' });
    expect(c.snapshot().phase).toBe('tts_waiting');

    c.handle({ type: 'agent_idle' });
    expect(c.snapshot().phase).toBe('tts_waiting');

    const actions = c.handle({ type: 'user_speech_started' });
    expect(actions).toContainEqual(expect.objectContaining({
      type: 'log',
      event: 'barge_in.candidate',
      data: expect.objectContaining({
        overlap: false,
        pendingAudio: true,
        audioId: 'a1',
        snapshot: expect.objectContaining({ phase: 'user_speaking', suppressTranscript: false }),
      }),
    }));
    expect(actions.some((a) => a.type === 'interrupt_agent_speech')).toBe(false);

    const confirmed = c.handle({ type: 'transcript_final', textChars: 3 });
    expect(confirmed).toContainEqual(expect.objectContaining({
      type: 'interrupt_agent_speech',
      reason: 'transcript_final',
      snapshot: expect.objectContaining({ phase: 'user_speaking', suppressTranscript: false }),
    }));
    expect(c.snapshot()).toMatchObject({
      phase: 'user_speaking',
      agentSpeaking: false,
      suppressTranscript: false,
    });
  });

  it('logs state transitions with a full interaction snapshot', () => {
    const c = new VoiceInterruptionController();

    const actions = c.handle({ type: 'intent_grace_started' });

    expect(actions).toContainEqual({
      type: 'log',
      event: 'voice_interaction.state',
      data: {
        reason: 'intent_grace_started',
        snapshot: expect.objectContaining({
          phase: 'endpoint_grace',
          agentSpeaking: false,
          userSpeaking: false,
          suppressTranscript: false,
          currentAudioId: undefined,
        }),
      },
    });
  });

  it('keeps a stable turn id from user speech through playback completion', () => {
    const c = new VoiceInterruptionController({ idFactory: () => 'utt-1' });

    const start = c.handle({ type: 'user_speech_started' });
    expect(start).toContainEqual({
      type: 'log',
      event: 'voice_interaction.state',
      turnId: 'utt-1',
      data: expect.objectContaining({
        snapshot: expect.objectContaining({ interactionId: 'utt-1', utteranceId: 'utt-1' }),
      }),
    });
    expect(c.logContext()).toEqual({
      turnId: 'utt-1',
      data: { interactionId: 'utt-1', utteranceId: 'utt-1' },
    });

    c.handle({ type: 'user_speech_stopped' });
    c.handle({ type: 'intent_grace_started' });
    c.handle({ type: 'intent_committed' });
    c.handle({ type: 'agent_thinking_started' });
    c.handle({ type: 'agent_response_ready', audioId: 'a1' });
    c.handle({ type: 'agent_speech_started', audioId: 'a1' });
    const end = c.handle({ type: 'agent_speech_ended', audioId: 'a1' });

    expect(end).toContainEqual({
      type: 'log',
      event: 'agent_speech.end',
      turnId: 'utt-1',
      data: expect.objectContaining({ interactionId: 'utt-1', utteranceId: 'utt-1', audioId: 'a1' }),
    });
    expect(c.logContext()).toEqual({ turnId: undefined, data: undefined });
  });
});
