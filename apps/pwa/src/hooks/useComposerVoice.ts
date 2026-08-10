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
import type { VoiceConfig } from '@sumicom/quicksave-shared';
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
  /** Stop capture and discard the current utterance without transcribing it. */
  cancelListening: () => void;
  /** Confirmed barge-in: stop remote WebRTC TTS without closing the mic. */
  interruptPlayback: () => void;
  /** True while a live utterance is streaming or a batch clip is recording. */
  recording: boolean;
  /** True between press and capture actually starting (setup in progress). */
  arming: boolean;
  /** True after capture stops and until the final transcript is available. */
  transcribing: boolean;
  /** Recoverable timeout shown inside the transcription overlay. */
  transcriptionError: string | null;
  /** Re-submit the retained audio after a recoverable timeout. */
  retryTranscription: () => void;
  /** Discard retained audio and close the transcription overlay. */
  cancelTranscription: () => void;
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
  onRemotePlayback?: (active: boolean, streamId: string) => void;
  shouldSuppressTranscript?: () => boolean;
  getLogContext?: () => { turnId?: string; data?: Record<string, unknown> };
  keepStreamingMicAlive?: boolean;
  /** Hard lifecycle gate used by voice coworker pages. Disabled pages create no audio resources. */
  streamingConnectionEnabled?: boolean;
  streamTransportId?: string;
  streamVoiceSessionId?: string;
}

// Browser capabilities required to capture mic audio (both modes use
// getUserMedia; streaming additionally needs a WebRTC media transceiver).
const browserCanCapture =
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
const browserCanStream =
  browserCanCapture && typeof RTCPeerConnection !== 'undefined' && typeof AudioContext !== 'undefined';

// After the realtime API yields a VAD stop/final fragment, hold briefly before
// submitting to the LLM. This keeps the UI responsive while still giving users
// a small window to resume after a natural pause.
const STREAM_INTENT_SILENCE_MS = 1000;
const STREAM_COMMIT_GRACE_MS = 500;
const STREAM_TRANSCRIPTION_TIMEOUT_MS = 15_000;

function isTimeoutError(error: unknown): boolean {
  return /timed?\s*out|timeout/i.test(error instanceof Error ? error.message : String(error));
}

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
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [arming, setArming] = useState(false);
  // Set when a user-gesture attempt to establish the streaming link fails (e.g.
  // no TURN on this network). Drives the disabled/greyed mic affordance. We
  // deliberately do NOT mirror the prewarm's failure here: on iOS the passive
  // prewarm can't grab the mic so it always fails, and surfacing that would
  // wrongly disable the button before the user ever taps.
  const [liveUnavailable, setLiveUnavailable] = useState(false);

  // Latest onError without re-subscribing effects on every parent render.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const streamFragmentsRef = useRef<string[]>([]);
  const streamSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamTranscriptionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptionKindRef = useRef<'streaming' | 'batch' | null>(null);
  const pendingBatchRef = useRef<{ blob: Blob; config: VoiceConfig } | null>(null);
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
    onRemotePlayback: resolvedOptions?.onRemotePlayback,
    shouldSuppressTranscript: resolvedOptions?.shouldSuppressTranscript,
    getLogContext: resolvedOptions?.getLogContext,
    keepStreamingMicAlive: resolvedOptions?.keepStreamingMicAlive,
  });
  cueCallbacksRef.current = {
    onGraceStarted: resolvedOptions?.onGraceStarted,
    onIntentCommitted: resolvedOptions?.onIntentCommitted,
    onIntentCancelled: resolvedOptions?.onIntentCancelled,
    onSpeechStarted: resolvedOptions?.onSpeechStarted,
    onSpeechStopped: resolvedOptions?.onSpeechStopped,
    onTranscriptPartial: resolvedOptions?.onTranscriptPartial,
    onTranscriptFinal: resolvedOptions?.onTranscriptFinal,
    onRemotePlayback: resolvedOptions?.onRemotePlayback,
    shouldSuppressTranscript: resolvedOptions?.shouldSuppressTranscript,
    getLogContext: resolvedOptions?.getLogContext,
    keepStreamingMicAlive: resolvedOptions?.keepStreamingMicAlive,
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

  const finishStreamingTranscription = useCallback(() => {
    if (streamTranscriptionTimerRef.current) {
      clearTimeout(streamTranscriptionTimerRef.current);
      streamTranscriptionTimerRef.current = null;
    }
    transcriptionKindRef.current = null;
    setTranscriptionError(null);
    setTranscribing(false);
  }, []);

  const beginStreamingTranscription = useCallback(() => {
    if (streamTranscriptionTimerRef.current) clearTimeout(streamTranscriptionTimerRef.current);
    transcriptionKindRef.current = 'streaming';
    setTranscriptionError(null);
    setTranscribing(true);
    streamTranscriptionTimerRef.current = setTimeout(() => {
      streamTranscriptionTimerRef.current = null;
      logStreamingEvent('asr.final_timeout', { timeoutMs: STREAM_TRANSCRIPTION_TIMEOUT_MS });
      setTranscriptionError('Transcription timed out.');
    }, STREAM_TRANSCRIPTION_TIMEOUT_MS);
  }, [logStreamingEvent]);

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
    try {
      if (text) {
        logStreamingEvent('intent.endpoint', { reason: 'grace_elapsed', fragmentCount, text, textChars: text.length });
        onTranscriptRef.current(text);
        cueCallbacksRef.current.onIntentCommitted?.();
        logStreamingEvent('voice_agent.utterance.sent', { textChars: text.length });
      }
    } finally {
      finishStreamingTranscription();
    }
  }, [clearStreamingEndpointTimers, finishStreamingTranscription, logStreamingEvent]);

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
    if (!trimmed) {
      finishStreamingTranscription();
      return;
    }
    // A late final may arrive after the timeout UI appeared. Return to the
    // progress state while the normal endpoint grace period completes.
    setTranscriptionError(null);
    streamFragmentsRef.current.push(trimmed);
    logStreamingEvent('asr.final_fragment', {
      text: trimmed,
      textChars: trimmed.length,
      fragmentCount: streamFragmentsRef.current.length,
    });
    scheduleStreamingEndpoint();
  }, [finishStreamingTranscription, logStreamingEvent, scheduleStreamingEndpoint]);

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
    (active, streamId) => cueCallbacksRef.current.onRemotePlayback?.(active, streamId),
    {
      transportSessionId: resolvedOptions?.streamTransportId ?? resolvedOptions?.sessionIdForLogs,
      voiceSessionId: resolvedOptions?.streamVoiceSessionId,
      enabled: resolvedOptions?.streamingConnectionEnabled ?? true,
    },
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
    if (resolvedOptions?.streamingConnectionEnabled === false) return;
    if (!agentId || mode !== 'streaming' || !streamingSupported) return;
    let cancelled = false;
    void getVoiceConfig().then((c) => {
      if (!cancelled && isVoiceConfigUsable(c)) void voiceStream.ensure();
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, mode, streamingSupported, resolvedOptions?.streamingConnectionEnabled]);

  useEffect(() => {
    if (!voiceStream.error) return;
    finishStreamingTranscription();
    onErrorRef.current(voiceStream.error);
  }, [finishStreamingTranscription, voiceStream.error]);

  useEffect(() => () => {
    if (streamTranscriptionTimerRef.current) clearTimeout(streamTranscriptionTimerRef.current);
    clearStreamingEndpointTimers();
  }, [clearStreamingEndpointTimers]);

  const stopArming = useCallback(() => {
    setArming(false);
  }, []);

  const runBatchTranscription = useCallback(async (blob: Blob, config: VoiceConfig) => {
    pendingBatchRef.current = { blob, config };
    transcriptionKindRef.current = 'batch';
    setTranscriptionError(null);
    setTranscribing(true);
    try {
      const text = await transcribeViaAgent(blob, config, agentId);
      if (text) onTranscriptRef.current(text);
      pendingBatchRef.current = null;
      transcriptionKindRef.current = null;
      setTranscribing(false);
    } catch (err) {
      if (isTimeoutError(err)) {
        setTranscriptionError('Transcription timed out.');
        return;
      }
      pendingBatchRef.current = null;
      transcriptionKindRef.current = null;
      setTranscribing(false);
      if (err instanceof DOMException && err.name === 'AbortError') return;
      onErrorRef.current(err instanceof Error ? err.message : 'Transcription failed.');
    }
  }, [agentId]);

  const batchStopAndTranscribe = useCallback(async () => {
    transcriptionKindRef.current = 'batch';
    setTranscriptionError(null);
    setTranscribing(true);
    try {
      const blob = await recorder.stop();
      if (!blob) {
        transcriptionKindRef.current = null;
        setTranscribing(false);
        return;
      }
      const config = await getVoiceConfig();
      if (!isVoiceConfigUsable(config)) {
        setConfigured(false);
        transcriptionKindRef.current = null;
        setTranscribing(false);
        onErrorRef.current('Voice transcription is not configured. Set it up in Settings.');
        return;
      }
      await runBatchTranscription(blob, config);
    } catch (err) {
      transcriptionKindRef.current = null;
      setTranscribing(false);
      onErrorRef.current(err instanceof Error ? err.message : 'Transcription failed.');
    }
  }, [recorder, runBatchTranscription]);

  const stopListening = useCallback(() => {
    if (voiceStream.recording) {
      beginStreamingTranscription();
      voiceStream.stop({ releaseMic: !cueCallbacksRef.current.keepStreamingMicAlive });
      scheduleStreamingEndpoint(0);
      return;
    }
    if (recorder.state === 'recording') {
      void batchStopAndTranscribe();
    }
  }, [voiceStream, recorder.state, batchStopAndTranscribe, beginStreamingTranscription, scheduleStreamingEndpoint]);

  const cancelListening = useCallback(() => {
    clearStreamingEndpointTimers();
    streamFragmentsRef.current = [];
    finishStreamingTranscription();
    if (voiceStream.recording) {
      voiceStream.stop({
        releaseMic: !cueCallbacksRef.current.keepStreamingMicAlive,
        discard: true,
      });
      cueCallbacksRef.current.onIntentCancelled?.();
      logStreamingEvent('intent.capture_cancelled');
      return;
    }
    if (recorder.state === 'recording') recorder.cancel();
  }, [clearStreamingEndpointTimers, finishStreamingTranscription, logStreamingEvent, recorder, voiceStream]);

  const retryTranscription = useCallback(() => {
    if (transcriptionKindRef.current === 'streaming') {
      streamFragmentsRef.current = [];
      voiceStream.retryTranscription();
      beginStreamingTranscription();
      logStreamingEvent('asr.retry_requested');
      return;
    }
    const pending = pendingBatchRef.current;
    if (pending) void runBatchTranscription(pending.blob, pending.config);
  }, [beginStreamingTranscription, logStreamingEvent, runBatchTranscription, voiceStream]);

  const cancelTranscription = useCallback(() => {
    clearStreamingEndpointTimers();
    streamFragmentsRef.current = [];
    pendingBatchRef.current = null;
    if (transcriptionKindRef.current === 'streaming') {
      voiceStream.stop({ releaseMic: false, discard: true });
      logStreamingEvent('asr.retry_cancelled');
    }
    finishStreamingTranscription();
  }, [clearStreamingEndpointTimers, finishStreamingTranscription, logStreamingEvent, voiceStream]);

  const startListening = useCallback(async (): Promise<boolean> => {
    if (resolvedOptions?.streamingConnectionEnabled === false) return false;
    if (transcribing || arming) return false;
    if (voiceStream.recording || recorder.state === 'recording') return true;
    // Show preparation immediately. Streaming start resolves only after the
    // first PCM frame reaches the DataChannel; batch start resolves only after
    // MediaRecorder has entered its recording state.
    setArming(true);
    try {
      const config = await getVoiceConfig();
      if (!isVoiceConfigUsable(config)) {
        setConfigured(false);
        onErrorRef.current('Voice transcription is not configured. Set it up in Settings.');
        return false;
      }
      setConfigured(true);
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
  }, [transcribing, arming, mode, voiceStream, recorder.state, recorder, stopArming, resolvedOptions?.streamingConnectionEnabled]);

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
    cancelListening,
    interruptPlayback: voiceStream.interruptPlayback,
    recording: voiceStream.recording || recorder.state === 'recording',
    arming,
    transcribing,
    transcriptionError,
    retryTranscription,
    cancelTranscription,
    busy: transcribing || arming,
    interim: voiceStream.interim,
    configured,
    streaming: voiceStream.recording,
    unavailable: mode === 'streaming' && streamingSupported && liveUnavailable,
  };
}
