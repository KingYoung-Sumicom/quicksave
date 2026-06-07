// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Shared voice-input logic for message composers (ClaudePanel + the new-session
 * view). The input mode is user-selected (VoiceConfig.mode):
 *
 * - `streaming` — live WebRTC + realtime ASR. Requires the machine to advertise
 *   `audio.streaming` (wrtc) and the P2P link to establish; otherwise the mic
 *   is hidden / disabled (no automatic fallback).
 * - `batch` — record-then-send to `/audio/transcriptions`. Requires the machine
 *   to advertise `audio.transcription`.
 *
 * The hook owns the mic lifecycle + the "arming" state and feeds finalized
 * transcripts to the caller; the caller renders the button and decides where
 * transcript text goes (`onTranscript`) and how errors surface (`onError`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '../stores/connectionStore';
import { getVoiceConfig } from '../lib/secureStorage';
import { transcribeViaAgent, isVoiceConfigUsable } from '../lib/voiceTranscription';
import { logVoiceEvent } from '../lib/voiceAgentClient';
import { useVoiceRecorder } from './useVoiceRecorder';
import { useVoiceStream } from './useVoiceStream';

export interface UseComposerVoice {
  /** Whether to render the mic button at all (browser can capture + machine
   *  supports the selected mode). */
  showMic: boolean;
  /** Press handler: starts or stops capture for the selected mode. */
  onMicPress: () => Promise<void>;
  /** Explicitly start capture without toggling an active stream off. */
  startListening: () => Promise<boolean>;
  /** Explicitly stop capture. In streaming mode this releases the mic track. */
  stopListening: () => void;
  /** True while a live utterance is streaming or a batch clip is recording. */
  recording: boolean;
  /** True between press and capture actually starting (setup in progress). */
  arming: boolean;
  /** True while a batch clip is being transcribed (post-recording). */
  transcribing: boolean;
  /** recording || arming || transcribing — the button should reflect this. */
  busy: boolean;
  /** Live partial transcript for the in-progress streaming utterance. */
  interim: string;
  /** True when a usable VoiceConfig is stored (for the idle tooltip). */
  configured: boolean;
  /** True while a live streaming utterance is in progress (drives the caption). */
  streaming: boolean;
  /** Streaming mode only: P2P couldn't be established on this network (no
   *  TURN). The mic is shown but disabled, since there is no fallback. */
  unavailable: boolean;
}

export interface UseComposerVoiceOptions {
  sessionIdForLogs?: string;
  onGraceStarted?: () => void;
  onIntentCommitted?: () => void;
  onIntentCancelled?: () => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onTranscriptPartial?: (textChars: number) => void;
  onTranscriptFinal?: (textChars: number) => void;
  shouldSuppressTranscript?: () => boolean;
  getLogContext?: () => { turnId?: string; data?: Record<string, unknown> };
}

// Browser capabilities required to capture mic audio (both modes use
// getUserMedia; streaming additionally needs WebRTC + AudioContext).
const browserCanCapture =
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
const browserCanStream =
  browserCanCapture && typeof RTCPeerConnection !== 'undefined' && typeof AudioContext !== 'undefined';

// After the realtime API yields a VAD stop/final fragment, hold briefly before
// submitting to the LLM. This keeps the UI responsive while still giving users
// a small window to resume after a natural pause.
const STREAM_INTENT_SILENCE_MS = 1000;
const STREAM_COMMIT_GRACE_MS = 500;

export function useComposerVoice(
  agentId: string,
  onTranscript: (text: string) => void,
  onError: (message: string) => void,
  options?: UseComposerVoiceOptions | string,
): UseComposerVoice {
  const resolvedOptions = typeof options === 'string' ? { sessionIdForLogs: options } : options;
  const agentAudio = useConnectionStore((s) => (agentId ? s.agentConnections[agentId]?.audio : undefined));
  const streamingSupported = !!agentAudio?.streaming;
  const batchSupported = !!agentAudio?.transcription;

  const recorder = useVoiceRecorder();

  const [mode, setMode] = useState<'streaming' | 'batch'>('streaming');
  const [configured, setConfigured] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [arming, setArming] = useState(false);
  // Set when a user-gesture attempt to establish the streaming link fails (e.g.
  // no TURN on this network). Drives the disabled/greyed mic affordance. We
  // deliberately do NOT mirror the prewarm's failure here: on iOS the passive
  // prewarm can't grab the mic so it always fails, and surfacing that would
  // wrongly disable the button before the user ever taps.
  const [liveUnavailable, setLiveUnavailable] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest onError without re-subscribing effects on every parent render.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const streamFragmentsRef = useRef<string[]>([]);
  const streamSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIdForLogsRef = useRef(resolvedOptions?.sessionIdForLogs);
  sessionIdForLogsRef.current = resolvedOptions?.sessionIdForLogs;
  const cueCallbacksRef = useRef({
    onGraceStarted: resolvedOptions?.onGraceStarted,
    onIntentCommitted: resolvedOptions?.onIntentCommitted,
    onIntentCancelled: resolvedOptions?.onIntentCancelled,
    onSpeechStarted: resolvedOptions?.onSpeechStarted,
    onSpeechStopped: resolvedOptions?.onSpeechStopped,
    onTranscriptPartial: resolvedOptions?.onTranscriptPartial,
    onTranscriptFinal: resolvedOptions?.onTranscriptFinal,
    shouldSuppressTranscript: resolvedOptions?.shouldSuppressTranscript,
    getLogContext: resolvedOptions?.getLogContext,
  });
  cueCallbacksRef.current = {
    onGraceStarted: resolvedOptions?.onGraceStarted,
    onIntentCommitted: resolvedOptions?.onIntentCommitted,
    onIntentCancelled: resolvedOptions?.onIntentCancelled,
    onSpeechStarted: resolvedOptions?.onSpeechStarted,
    onSpeechStopped: resolvedOptions?.onSpeechStopped,
    onTranscriptPartial: resolvedOptions?.onTranscriptPartial,
    onTranscriptFinal: resolvedOptions?.onTranscriptFinal,
    shouldSuppressTranscript: resolvedOptions?.shouldSuppressTranscript,
    getLogContext: resolvedOptions?.getLogContext,
  };

  const logStreamingEvent = useCallback((event: string, data: Record<string, unknown> = {}) => {
    const ctx = cueCallbacksRef.current.getLogContext?.();
    logVoiceEvent(agentId, {
      sessionId: sessionIdForLogsRef.current,
      event,
      phase: 'intent',
      turnId: ctx?.turnId,
      data: { ...(ctx?.data ?? {}), ...data },
    });
  }, [agentId]);

  const clearStreamingEndpointTimers = useCallback(() => {
    if (streamSilenceTimerRef.current) {
      clearTimeout(streamSilenceTimerRef.current);
      streamSilenceTimerRef.current = null;
    }
    if (streamGraceTimerRef.current) {
      clearTimeout(streamGraceTimerRef.current);
      streamGraceTimerRef.current = null;
    }
  }, []);

  const flushStreamingIntent = useCallback(() => {
    clearStreamingEndpointTimers();
    const text = streamFragmentsRef.current.join(' ').replace(/\s+/g, ' ').trim();
    const fragmentCount = streamFragmentsRef.current.length;
    streamFragmentsRef.current = [];
    if (text) {
      logStreamingEvent('intent.endpoint', { reason: 'grace_elapsed', fragmentCount, text, textChars: text.length });
      onTranscriptRef.current(text);
      cueCallbacksRef.current.onIntentCommitted?.();
      logStreamingEvent('voice_agent.utterance.sent', { textChars: text.length });
    }
  }, [clearStreamingEndpointTimers, logStreamingEvent]);

  const scheduleStreamingEndpoint = useCallback((delayMs = STREAM_INTENT_SILENCE_MS) => {
    if (streamFragmentsRef.current.length === 0) return;
    clearStreamingEndpointTimers();
    streamSilenceTimerRef.current = setTimeout(() => {
      streamSilenceTimerRef.current = null;
      logStreamingEvent('intent.commit_pending', {
        silenceMs: delayMs,
        graceMs: STREAM_COMMIT_GRACE_MS,
        fragmentCount: streamFragmentsRef.current.length,
      });
      cueCallbacksRef.current.onGraceStarted?.();
      streamGraceTimerRef.current = setTimeout(() => {
        streamGraceTimerRef.current = null;
        flushStreamingIntent();
      }, STREAM_COMMIT_GRACE_MS);
    }, delayMs);
  }, [clearStreamingEndpointTimers, flushStreamingIntent]);

  const cancelPendingStreamingCommit = useCallback(() => {
    if (streamSilenceTimerRef.current || streamGraceTimerRef.current) {
      logStreamingEvent('intent.commit_cancelled', { reason: 'speech_activity' });
      cueCallbacksRef.current.onIntentCancelled?.();
    }
    clearStreamingEndpointTimers();
  }, [clearStreamingEndpointTimers, logStreamingEvent]);

  const handleStreamingFinalFragment = useCallback((text: string) => {
    cueCallbacksRef.current.onTranscriptFinal?.(text.length);
    if (cueCallbacksRef.current.shouldSuppressTranscript?.()) {
      logStreamingEvent('asr.final_fragment_ignored', { reason: 'transcript_suppressed', textChars: text.length });
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    streamFragmentsRef.current.push(trimmed);
    logStreamingEvent('asr.final_fragment', {
      text: trimmed,
      textChars: trimmed.length,
      fragmentCount: streamFragmentsRef.current.length,
    });
    scheduleStreamingEndpoint();
  }, [logStreamingEvent, scheduleStreamingEndpoint]);

  const handleStreamingSpeechActivity = useCallback((active: boolean) => {
    if (active) {
      cueCallbacksRef.current.onSpeechStarted?.();
      logStreamingEvent('vad.speech_started');
      cancelPendingStreamingCommit();
      return;
    }
    cueCallbacksRef.current.onSpeechStopped?.();
    logStreamingEvent('vad.speech_stopped');
    scheduleStreamingEndpoint();
  }, [cancelPendingStreamingCommit, logStreamingEvent, scheduleStreamingEndpoint]);

  const handleStreamingPartial = useCallback((text: string) => {
    cueCallbacksRef.current.onTranscriptPartial?.(text.length);
    if (cueCallbacksRef.current.shouldSuppressTranscript?.()) {
      if (text.trim()) logStreamingEvent('asr.partial_ignored', { reason: 'transcript_suppressed', textChars: text.length });
      return;
    }
    if (text.trim()) {
      logStreamingEvent('asr.partial', { textChars: text.length });
      scheduleStreamingEndpoint();
    }
  }, [logStreamingEvent, scheduleStreamingEndpoint]);

  const voiceStream = useVoiceStream(
    agentId,
    handleStreamingFinalFragment,
    handleStreamingSpeechActivity,
    handleStreamingPartial,
  );

  useEffect(() => {
    let cancelled = false;
    getVoiceConfig().then((c) => {
      if (cancelled || !c) return;
      setConfigured(isVoiceConfigUsable(c));
      setMode(c.mode);
    });
    return () => { cancelled = true; };
  }, []);

  // Prewarm the WebRTC link so the first streaming utterance starts instantly.
  useEffect(() => {
    if (!agentId || mode !== 'streaming' || !streamingSupported) return;
    void getVoiceConfig().then((c) => { if (isVoiceConfigUsable(c)) void voiceStream.ensure(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, mode, streamingSupported]);

  useEffect(() => {
    if (voiceStream.error) onErrorRef.current(voiceStream.error);
  }, [voiceStream.error]);

  useEffect(() => () => {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    clearStreamingEndpointTimers();
  }, [clearStreamingEndpointTimers]);

  const stopArming = useCallback(() => {
    if (armTimerRef.current) { clearTimeout(armTimerRef.current); armTimerRef.current = null; }
    setArming(false);
  }, []);

  const batchStopAndTranscribe = useCallback(async () => {
    const blob = await recorder.stop();
    if (!blob) return;
    const config = await getVoiceConfig();
    if (!isVoiceConfigUsable(config)) {
      setConfigured(false);
      onErrorRef.current('Voice transcription is not configured. Set it up in Settings.');
      return;
    }
    setTranscribing(true);
    try {
      const text = await transcribeViaAgent(blob, config, agentId);
      if (text) onTranscript(text);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      onErrorRef.current(err instanceof Error ? err.message : 'Transcription failed.');
    } finally {
      setTranscribing(false);
    }
  }, [recorder, agentId, onTranscript]);

  const stopListening = useCallback(() => {
    if (voiceStream.recording) {
      voiceStream.stop();
      scheduleStreamingEndpoint(0);
      return;
    }
    if (recorder.state === 'recording') {
      void batchStopAndTranscribe();
    }
  }, [voiceStream, recorder.state, batchStopAndTranscribe, scheduleStreamingEndpoint]);

  const startListening = useCallback(async (): Promise<boolean> => {
    if (transcribing || arming) return false;
    if (voiceStream.recording || recorder.state === 'recording') return true;
    const config = await getVoiceConfig();
    if (!isVoiceConfigUsable(config)) {
      setConfigured(false);
      onErrorRef.current('Voice transcription is not configured. Set it up in Settings.');
      return false;
    }
    setConfigured(true);
    armTimerRef.current = setTimeout(() => setArming(true), 120);
    try {
      if (mode === 'streaming') {
        // Establish the P2P link on this gesture if it isn't up yet — the mic
        // permission grab is what unlocks Safari's host ICE candidates — then
        // start recording. start() resolves false if the link can't be made.
        setLiveUnavailable(false);
        const ok = await voiceStream.start();
        if (!ok) {
          setLiveUnavailable(true);
          onErrorRef.current('Live voice couldn’t connect on this network.');
        }
        return ok;
      } else {
        await recorder.start();
        return true;
      }
    } catch (err) {
      onErrorRef.current(err instanceof Error ? err.message : 'Could not start voice input.');
      return false;
    } finally {
      stopArming();
    }
  }, [transcribing, arming, mode, voiceStream, recorder.state, recorder, stopArming]);

  const onMicPress = useCallback(async () => {
    if (transcribing || arming) return;
    // Stop whichever capture is in progress.
    if (voiceStream.recording || recorder.state === 'recording') {
      stopListening();
      return;
    }
    await startListening();
  }, [transcribing, arming, voiceStream.recording, recorder.state, stopListening, startListening]);

  const modeSupported = mode === 'streaming' ? (browserCanStream && streamingSupported) : (browserCanCapture && batchSupported);

  return {
    showMic: modeSupported,
    onMicPress,
    startListening,
    stopListening,
    recording: voiceStream.recording || recorder.state === 'recording',
    arming,
    transcribing,
    busy: transcribing || arming,
    interim: voiceStream.interim,
    configured,
    streaming: voiceStream.recording,
    unavailable: mode === 'streaming' && streamingSupported && liveUnavailable,
  };
}
