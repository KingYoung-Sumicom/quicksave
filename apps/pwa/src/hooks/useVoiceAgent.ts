// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * Orchestrates the voice intermediary ("AI coworker") on the PWA side:
 *  - attaches the daemon agent to the current session and subscribes to its
 *    `/sessions/:id/voice-agent` push channel,
 *  - reuses the existing composer STT (streaming OR batch) to capture the user's
 *    speech, routing the final transcript to the agent instead of the composer,
 *  - plays the agent's spoken replies, with barge-in the moment the user talks.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  VoiceAgentEvent,
  VoiceAgentRuntimeStatus,
  VoiceAgentState,
  VoiceAgentTraceEntry,
} from '@sumicom/quicksave-shared';
import { getVoiceConfig } from '../lib/secureStorage';
import { getBusForAgent } from '../lib/busRegistry';
import {
  attachVoiceAgent,
  detachVoiceAgent,
  sendVoiceAgentUtterance,
  sendVoiceAgentPlaybackEvent,
  fetchVoiceAgentAudio,
  logVoiceEvent,
  reloadVoiceAgent,
} from '../lib/voiceAgentClient';
import { VoiceCues, VoiceOutput } from '../lib/voiceOutput';
import {
  VoiceInterruptionController,
  type VoiceInterruptionAction,
  type VoiceInterruptionEvent,
} from '../lib/voiceInterruptionController';
import { useComposerVoice } from './useComposerVoice';
import { useScreenWakeLock } from './useScreenWakeLock';

export interface UseVoiceAgent {
  enabled: boolean;
  toggle: () => void;
  /** Brain configured AND session live — i.e. the agent will actually respond. */
  active: boolean;
  state: VoiceAgentState;
  lastTranscript: string;
  lastSpoken: string;
  actionLog: string[];
  error: string | null;
  // Talk affordance — reuses the existing composer mic (both STT modes).
  onTalkPress: () => void;
  recording: boolean;
  interim: string;
  busy: boolean;
  showMic: boolean;
  traceLog: VoiceAgentTraceEntry[];
  clearTrace: () => void;
  runtime: VoiceAgentRuntimeStatus | null;
  reloading: boolean;
  reload: () => Promise<void>;
}

export function useVoiceAgent(agentId: string, sessionId: string | undefined): UseVoiceAgent {
  const clientIdRef = useRef(`voice-page-${crypto.randomUUID()}`);
  const transportIdRef = useRef(`voice-rtc-${crypto.randomUUID()}`);
  const [enabled, setEnabled] = useState(false);
  const [active, setActive] = useState(false);
  const [state, setState] = useState<VoiceAgentState>('idle');
  const [lastTranscript, setLastTranscript] = useState('');
  const [lastSpoken, setLastSpoken] = useState('');
  const [actionLog, setActionLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [traceLog, setTraceLog] = useState<VoiceAgentTraceEntry[]>([]);
  const [runtime, setRuntime] = useState<VoiceAgentRuntimeStatus | null>(null);
  const [reloading, setReloading] = useState(false);
  const outputRef = useRef<VoiceOutput | null>(null);
  const cuesRef = useRef<VoiceCues | null>(null);
  const autoListenPausedRef = useRef(false);
  const autoListenAttemptedRef = useRef(false);
  const interruptionRef = useRef(new VoiceInterruptionController());
  const voiceRef = useRef<ReturnType<typeof useComposerVoice> | null>(null);
  useScreenWakeLock(enabled && active);

  const onTranscript = useCallback(
    (text: string) => {
      if (!sessionId) {
        setTimeout(() => cuesRef.current?.stopProcessing(), 0);
        setError('目前沒有可用的 session，語音訊息沒有送出。');
        return;
      }
      const ctx = interruptionRef.current.logContext();
      outputRef.current?.interrupt(); // barge-in: cut the agent off when the user speaks
      setError(null);
      setLastTranscript(text);
      void sendVoiceAgentUtterance(agentId, sessionId, text, {
        turnId: ctx.turnId,
        interactionId: ctx.data?.interactionId as string | undefined,
        utteranceId: ctx.data?.utteranceId as string | undefined,
      })
        .then((res) => {
          if (res.ok) return;
          cuesRef.current?.stopProcessing();
          setError(res.error ?? '語音訊息沒有送進 voice agent。');
        })
        .catch((e) => {
          cuesRef.current?.stopProcessing();
          setError(String(e?.message ?? e));
        });
    },
    [agentId, sessionId],
  );

  const runInterruptionActions = useCallback((actions: readonly VoiceInterruptionAction[]) => {
    for (const action of actions) {
      switch (action.type) {
        case 'log':
          logVoiceEvent(agentId, {
            sessionId,
            event: action.event,
            phase: 'interruption',
            turnId: action.turnId,
            data: action.data,
          });
          break;
        case 'interrupt_agent_speech':
          outputRef.current?.interrupt();
          voiceRef.current?.interruptPlayback();
          cuesRef.current?.stopProcessing();
          logVoiceEvent(agentId, {
            sessionId,
            event: 'barge_in.interrupt_agent_speech',
            phase: 'interruption',
            turnId: action.turnId,
            data: { reason: action.reason, snapshot: action.snapshot },
          });
          break;
        case 'cancel_pending_commit':
          cuesRef.current?.stopProcessing();
          break;
        case 'resume_agent_speech':
          logVoiceEvent(agentId, {
            sessionId,
            event: 'barge_in.resume_agent_speech_unimplemented',
            phase: 'interruption',
            data: { reason: action.reason },
          });
          break;
      }
    }
  }, [agentId, sessionId]);

  const handleInterruptionEvent = useCallback((event: VoiceInterruptionEvent) => {
    runInterruptionActions(interruptionRef.current.handle(event));
  }, [runInterruptionActions]);

  const startAutoListening = useCallback(async () => {
    const voiceNow = voiceRef.current;
    if (!voiceNow || autoListenPausedRef.current || voiceNow.recording || voiceNow.busy || !voiceNow.showMic) return;
    autoListenAttemptedRef.current = true;
    const ok = await voiceNow.startListening();
    if (!ok) {
      setError((prev) => prev ?? '瀏覽器可能需要你按一下麥克風，才能開始聆聽。');
    }
  }, []);

  const voice = useComposerVoice(agentId, onTranscript, setError, {
    sessionIdForLogs: sessionId,
    onGraceStarted: () => {
      handleInterruptionEvent({ type: 'intent_grace_started' });
      cuesRef.current?.graceStarted();
    },
    onIntentCommitted: () => {
      handleInterruptionEvent({ type: 'intent_committed' });
      cuesRef.current?.processingStarted();
      setTimeout(() => { void startAutoListening(); }, 0);
    },
    onIntentCancelled: () => {
      handleInterruptionEvent({ type: 'intent_cancelled', reason: 'speech_activity' });
      cuesRef.current?.stopProcessing();
    },
    onSpeechStarted: () => handleInterruptionEvent({ type: 'user_speech_started' }),
    onSpeechStopped: () => handleInterruptionEvent({ type: 'user_speech_stopped' }),
    onTranscriptPartial: (textChars) => handleInterruptionEvent({ type: 'transcript_partial', textChars }),
    onTranscriptFinal: (textChars) => handleInterruptionEvent({ type: 'transcript_final', textChars }),
    onRemotePlayback: (active, streamId) => {
      if (!sessionId) return;
      const ctx = interruptionRef.current.logContext();
      if (active) {
        cuesRef.current?.stopProcessing();
        handleInterruptionEvent({ type: 'agent_speech_started', audioId: streamId });
        setTimeout(() => { void startAutoListening(); }, 0);
        sendVoiceAgentPlaybackEvent(agentId, {
          sessionId,
          event: 'started',
          audioId: streamId,
          turnId: ctx.turnId,
          interactionId: ctx.data?.interactionId as string | undefined,
          utteranceId: ctx.data?.utteranceId as string | undefined,
        });
      } else {
        cuesRef.current?.stopProcessing();
        handleInterruptionEvent({ type: 'agent_speech_ended', audioId: streamId });
        sendVoiceAgentPlaybackEvent(agentId, {
          sessionId,
          event: 'ended',
          audioId: streamId,
          turnId: ctx.turnId,
          interactionId: ctx.data?.interactionId as string | undefined,
          utteranceId: ctx.data?.utteranceId as string | undefined,
        });
      }
    },
    shouldSuppressTranscript: () => interruptionRef.current.shouldSuppressTranscript(),
    getLogContext: () => interruptionRef.current.logContext(),
    keepStreamingMicAlive: true,
    streamingConnectionEnabled: enabled,
    streamTransportId: transportIdRef.current,
    streamVoiceSessionId: sessionId,
  });
  voiceRef.current = voice;

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let cancelled = false;
    let unsub: (() => void) | undefined;
    const cues = new VoiceCues();
    const output = new VoiceOutput(
      (audioId) => fetchVoiceAgentAudio(agentId, sessionId, audioId),
      undefined,
      {
        onPlaybackStart: (audioId) => {
          const ctx = interruptionRef.current.logContext();
          cues.stopProcessing();
          handleInterruptionEvent({ type: 'agent_speech_started', audioId });
          setTimeout(() => { void startAutoListening(); }, 0);
          sendVoiceAgentPlaybackEvent(agentId, {
            sessionId,
            event: 'started',
            audioId,
            turnId: ctx.turnId,
            interactionId: ctx.data?.interactionId as string | undefined,
            utteranceId: ctx.data?.utteranceId as string | undefined,
          });
        },
        onPlaybackEnd: (audioId) => {
          const ctx = interruptionRef.current.logContext();
          handleInterruptionEvent({ type: 'agent_speech_ended' });
          sendVoiceAgentPlaybackEvent(agentId, {
            sessionId,
            event: 'ended',
            audioId,
            turnId: ctx.turnId,
            interactionId: ctx.data?.interactionId as string | undefined,
            utteranceId: ctx.data?.utteranceId as string | undefined,
          });
        },
        onPlaybackInterrupted: (audioId) => {
          const ctx = interruptionRef.current.logContext();
          handleInterruptionEvent({ type: 'agent_speech_interrupted' });
          sendVoiceAgentPlaybackEvent(agentId, {
            sessionId,
            event: 'interrupted',
            audioId,
            turnId: ctx.turnId,
            interactionId: ctx.data?.interactionId as string | undefined,
            utteranceId: ctx.data?.utteranceId as string | undefined,
            reason: 'barge_in_or_dispose',
          });
        },
        onPlaybackUnavailable: (audioId) => {
          const ctx = interruptionRef.current.logContext();
          cues.stopProcessing();
          handleInterruptionEvent({ type: 'agent_speech_unavailable' });
          sendVoiceAgentPlaybackEvent(agentId, {
            sessionId,
            event: 'unavailable',
            audioId,
            turnId: ctx.turnId,
            interactionId: ctx.data?.interactionId as string | undefined,
            utteranceId: ctx.data?.utteranceId as string | undefined,
          });
        },
      },
    );
    outputRef.current = output;
    cuesRef.current = cues;
    setState('idle');
    setActionLog([]);

    void (async () => {
      const cfg = await getVoiceConfig();
      if (cancelled) return;
      if (!cfg) {
        setError('語音尚未在設定中配置。');
        return;
      }
      try {
        const res = await attachVoiceAgent(agentId, sessionId, cfg, clientIdRef.current);
        if (cancelled) return;
        setActive(!!res.active);
        if (res.runtime) setRuntime(res.runtime);
        if (res.traceHistory) {
          setTraceLog(res.traceHistory.slice(-200));
          const latestUser = [...res.traceHistory].reverse().find((entry) => entry.event === 'turn.started');
          const latestSpeech = [...res.traceHistory].reverse().find((entry) => entry.event === 'speech.proposed');
          const userText = latestUser?.data?.text;
          const speechText = latestSpeech?.data?.text;
          if (typeof userText === 'string') setLastTranscript(userText);
          if (typeof speechText === 'string') setLastSpoken(speechText);
        }
        if (!res.active) {
          autoListenPausedRef.current = true;
          voiceRef.current?.stopListening();
          setError(res.error ?? '語音 agent 模型未設定，或 session 未啟動。');
        }
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message ?? e));
      }
      const bus = getBusForAgent(agentId);
      unsub = bus?.subscribe<null, VoiceAgentEvent>(`/sessions/${sessionId}/voice-agent`, {
        onSnapshot: () => undefined,
        onUpdate: (ev) => {
          switch (ev.kind) {
            case 'state':
              setState(ev.state);
              if (ev.state === 'thinking') handleInterruptionEvent({ type: 'agent_thinking_started' });
              if (ev.state === 'idle') handleInterruptionEvent({ type: 'agent_idle' });
              break;
            case 'speech-text':
              setLastSpoken(ev.text);
              break;
            case 'speak':
              setLastSpoken(ev.text);
              handleInterruptionEvent({ type: 'agent_response_ready', audioId: ev.audioId || undefined });
              if (ev.audioId && !ev.streamed) {
                output.enqueue(ev.audioId);
              } else if (!ev.streamed) {
                cues.stopProcessing();
              }
              break;
            case 'action':
              setActionLog((log) => [...log.slice(-19), ev.summary]);
              break;
            case 'trace':
              setTraceLog((log) => [...log.slice(-199), ev.entry]);
              break;
            case 'runtime':
              setRuntime(ev.runtime);
              setReloading(ev.runtime.state === 'reloading' || ev.runtime.state === 'starting');
              break;
            case 'error':
              cues.stopProcessing();
              setError(ev.message);
              break;
          }
        },
        onError: (e) => setError(String((e as { message?: string })?.message ?? e)),
      });
    })();

    return () => {
      cancelled = true;
      unsub?.();
      cues.dispose();
      output.dispose();
      outputRef.current = null;
      cuesRef.current = null;
      interruptionRef.current.reset();
      autoListenAttemptedRef.current = false;
      autoListenPausedRef.current = false;
      voiceRef.current?.stopListening();
      setActive(false);
      void detachVoiceAgent(agentId, sessionId, clientIdRef.current);
    };
  }, [enabled, sessionId, agentId, startAutoListening]);

  useEffect(() => {
    if (!enabled || !active || autoListenAttemptedRef.current) return;
    void startAutoListening();
  }, [enabled, active, voice.showMic, voice.busy, voice.recording, startAutoListening]);

  const toggle = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    setError(null);
    if (next) {
      autoListenPausedRef.current = false;
      autoListenAttemptedRef.current = false;
    } else {
      autoListenPausedRef.current = false;
      autoListenAttemptedRef.current = false;
      interruptionRef.current.reset();
      voiceRef.current?.stopListening();
    }
  }, [enabled]);

  const onTalkPress = useCallback(() => {
    if (voice.recording) {
      autoListenPausedRef.current = true;
      voiceRef.current?.stopListening();
      return;
    }
    autoListenPausedRef.current = false;
    autoListenAttemptedRef.current = false;
    void startAutoListening();
  }, [startAutoListening, voice.recording]);

  const clearTrace = useCallback(() => setTraceLog([]), []);

  const reload = useCallback(async () => {
    if (!sessionId || reloading) return;
    setReloading(true);
    setError(null);
    try {
      const result = await reloadVoiceAgent(agentId, sessionId);
      setRuntime(result.runtime);
      if (!result.ok) setError(result.error ?? '語音同事重新載入失敗。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReloading(false);
    }
  }, [agentId, reloading, sessionId]);

  return {
    enabled,
    toggle,
    active,
    state,
    lastTranscript,
    lastSpoken,
    actionLog,
    error,
    onTalkPress,
    recording: voice.recording,
    interim: voice.interim,
    busy: voice.busy,
    showMic: voice.showMic,
    traceLog,
    clearTrace,
    runtime,
    reloading,
    reload,
  };
}
