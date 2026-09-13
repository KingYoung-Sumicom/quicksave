// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * React wrapper around `VoiceStreamSession`. Lazily establishes the WebRTC
 * connection on first use (`ensure`), exposes recording state + the live
 * interim transcript, and reports `unavailable` when P2P can't be set up so
 * the caller can fall back to batch transcription.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceConfig } from '@sumicom/quicksave-shared';
import { getVoiceConfig } from '../lib/secureStorage';
import { isVoiceConfigUsable } from '../lib/voiceTranscription';
import {
  acquireVoiceMicrophone,
  requestVoiceMicrophone,
  stopVoiceMicrophoneWhenReady,
  VoiceStreamSession,
  type VoiceRtcDebugEvent,
  type VoiceStreamState,
} from '../lib/voiceStreamClient';

const AUDIO_CONTEXT_START_TIMEOUT_MS = 3_000;

async function resumeAudioContext(context: AudioContext): Promise<void> {
  if (context.state !== 'suspended') return;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      context.resume(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Audio activation timed out.')), AUDIO_CONTEXT_START_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface ActivatedVoiceAudioContext {
  context: AudioContext;
  recoveredAfterTimeout: boolean;
}

/**
 * iOS Home Screen PWAs can leave the first AudioContext.resume() pending after
 * the page has spent a few minutes frozen in the background. getUserMedia,
 * started in the same tap, still commonly succeeds and wakes the native audio
 * session. Once that track is live, rebuilding the context recovers capture
 * without making the user tap a second time.
 */
export async function activateVoiceAudioContext(
  context: AudioContext,
  preparedMicrophone?: Promise<MediaStream>,
  createContext: () => AudioContext = () => new AudioContext(),
): Promise<ActivatedVoiceAudioContext> {
  try {
    await resumeAudioContext(context);
    if (context.state !== 'running') {
      throw new Error(`Microphone audio context did not start (state: ${context.state}).`);
    }
    return { context, recoveredAfterTimeout: false };
  } catch (error) {
    const timedOut = /Audio activation timed out/i.test(error instanceof Error ? error.message : String(error));
    if (!timedOut || !preparedMicrophone) throw error;

    // Await the already-started permission request; do not request a second
    // stream or consume another user activation.
    await acquireVoiceMicrophone(preparedMicrophone);
    void context.close().catch(() => undefined);

    const retry = createContext();
    try {
      await resumeAudioContext(retry);
      if (retry.state !== 'running') {
        throw new Error(`Microphone audio context did not start after foreground recovery (state: ${retry.state}).`);
      }
      return { context: retry, recoveredAfterTimeout: true };
    } catch (retryError) {
      void retry.close().catch(() => undefined);
      throw retryError;
    }
  }
}

export interface UseVoiceStream {
  /** True once the connection is usable for an utterance. */
  ready: boolean;
  recording: boolean;
  /** P2P could not be established — caller should use batch transcription. */
  unavailable: boolean;
  /** Live partial transcript for the in-progress utterance. */
  interim: string;
  error: string | null;
  /** Connect if not already; returns true when ready. Pass `acquireMic` to grab
   *  the mic before the offer (unlocks Safari's host ICE candidates). */
  ensure: (acquireMic?: boolean) => Promise<boolean>;
  /** Connect (mic-first) if needed, then begin an utterance. Resolves true once
   *  recording, false if the P2P link couldn't be established. */
  start: () => Promise<boolean>;
  stop: (opts?: { releaseMic?: boolean; discard?: boolean }) => void;
  retryTranscription: () => void;
  /** Re-send a locally retained PCM utterance after an agent/network failure. */
  replayTranscription: (frames: ArrayBuffer[]) => Promise<boolean>;
  interruptPlayback: () => void;
  disconnect: () => void;
}

export interface UseVoiceStreamOptions {
  transportSessionId?: string;
  voiceSessionId?: string;
  enabled?: boolean;
  transcriptionLocale?: VoiceConfig['transcriptionLocale'];
  /** Structured lifecycle diagnostics. Never includes microphone bytes or transcript text. */
  onDebug?: (event: VoiceRtcDebugEvent) => void;
}

export function useVoiceStream(
  agentId: string,
  onFinalText: (text: string) => void,
  onSpeechActivity?: (active: boolean) => void,
  onPartialText?: (text: string) => void,
  onAudioFrame?: (pcm: ArrayBuffer) => void,
  onRemotePlayback?: (active: boolean, streamId: string) => void,
  options: UseVoiceStreamOptions = {},
): UseVoiceStream {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<VoiceStreamState | 'idle'>('idle');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onDebugRef = useRef(options.onDebug);
  onDebugRef.current = options.onDebug;

  const debug = useCallback((event: VoiceRtcDebugEvent) => {
    onDebugRef.current?.(event);
  }, []);

  const sessionRef = useRef<VoiceStreamSession | null>(null);
  const connectingRef = useRef<Promise<boolean> | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const onFinalRef = useRef(onFinalText);
  onFinalRef.current = onFinalText;
  const onSpeechActivityRef = useRef(onSpeechActivity);
  onSpeechActivityRef.current = onSpeechActivity;
  const onPartialTextRef = useRef(onPartialText);
  onPartialTextRef.current = onPartialText;
  const onAudioFrameRef = useRef(onAudioFrame);
  onAudioFrameRef.current = onAudioFrame;
  const onRemotePlaybackRef = useRef(onRemotePlayback);
  onRemotePlaybackRef.current = onRemotePlayback;

  useEffect(() => {
    return () => {
      lifecycleGenerationRef.current++;
      sessionRef.current?.close();
      sessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    const discardFrozenSession = (reason: 'visibility-hidden' | 'pagehide') => {
      if (!sessionRef.current && !connectingRef.current) return;
      debug({
        t: 0,
        kind: 'info',
        detail: 'discarding voice session before background freeze',
        data: { reason },
      });
      lifecycleGenerationRef.current++;
      sessionRef.current?.close();
      sessionRef.current = null;
      connectingRef.current = null;
      setState('idle');
      setInterim('');
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') discardFrozenSession('visibility-hidden');
    };
    const onPageHide = () => discardFrozenSession('pagehide');
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [debug]);

  useEffect(() => {
    if (enabled) return;
    lifecycleGenerationRef.current++;
    sessionRef.current?.close();
    sessionRef.current = null;
    connectingRef.current = null;
    setState('idle');
    setInterim('');
  }, [enabled]);

  const ensure = useCallback(async (
    acquireMic = false,
    preparedMicrophone?: Promise<MediaStream>,
  ): Promise<boolean> => {
    if (!enabled) return false;
    if (sessionRef.current?.isReadyForCapture()) return true;
    if (connectingRef.current) {
      // A connect is already in flight (typically the passive prewarm). Wait for
      // it: reuse it if it produced a ready session; otherwise fall through and
      // retry — acquiring the mic this time if the gesture asked for it. The
      // prewarm can't grab the mic, so on iOS its attempt always fails, and a
      // tap landing inside that window must not inherit the doomed result.
      const inflight = await connectingRef.current;
      if (inflight && sessionRef.current?.isReadyForCapture()) return true;
      if (!acquireMic) return inflight;
    }

    const connect = (async () => {
      const generation = lifecycleGenerationRef.current;
      const storedConfig = await getVoiceConfig();
      const config = storedConfig && options.transcriptionLocale
        ? { ...storedConfig, transcriptionLocale: options.transcriptionLocale }
        : storedConfig;
      if (!enabledRef.current || generation !== lifecycleGenerationRef.current) return false;
      if (!isVoiceConfigUsable(config) || !agentId) {
        setState('unavailable');
        return false;
      }
      // A prior (e.g. prewarmed) session that never reached 'ready' may linger;
      // replace it so the gesture path can re-establish with the mic in hand.
      if (sessionRef.current) {
        sessionRef.current.close();
        sessionRef.current = null;
      }
      const session = new VoiceStreamSession(agentId, options.transportSessionId || crypto.randomUUID(), config, {
        onPartial: (text) => {
          setInterim(text);
          onPartialTextRef.current?.(text);
        },
        onAudioFrame: (pcm) => onAudioFrameRef.current?.(pcm),
        onFinal: (text) => {
          setInterim('');
          // Empty completion is still significant: it lets the composer leave
          // its post-stop transcription state without waiting for a timeout.
          onFinalRef.current(text);
        },
        onSpeechActivity: (active) => onSpeechActivityRef.current?.(active),
        onRemotePlayback: (active, streamId) => onRemotePlaybackRef.current?.(active, streamId),
        onError: (message) => {
          setInterim('');
          setError(message);
        },
        onState: (s) => setState(s),
      }, (event) => debug(event), options.voiceSessionId);
      sessionRef.current = session;
      const ok = await session.connect({ acquireMic, preparedMicrophone });
      if (!ok || !enabledRef.current || generation !== lifecycleGenerationRef.current) {
        session.close();
        if (sessionRef.current === session) sessionRef.current = null;
        return false;
      }
      return ok;
    })();

    connectingRef.current = connect;
    const result = await connect;
    if (connectingRef.current === connect) connectingRef.current = null;
    return result;
  }, [agentId, enabled, state, options.transportSessionId, options.voiceSessionId, options.transcriptionLocale]);

  const start = useCallback(async (): Promise<boolean> => {
    if (!enabled) return false;
    setError(null);
    const captureStartedAt = performance.now();
    const captureDebug = (
      kind: VoiceRtcDebugEvent['kind'],
      detail: string,
      data?: Record<string, unknown>,
    ) => debug({ t: Math.round(performance.now() - captureStartedAt), kind, detail, data });
    captureDebug('info', 'user-gesture capture start', {
      visibilityState: document.visibilityState,
      userActivationActive: navigator.userActivation?.isActive,
      userActivationHasBeenActive: navigator.userActivation?.hasBeenActive,
    });
    // Invoke getUserMedia synchronously in the original tap stack. In an iOS
    // Home Screen PWA, awaiting IndexedDB, prewarm, or signaling first can lose
    // the transient user activation and leave the permission promise pending.
    // Voice-coworker pages must claim their cross-page lease before capture,
    // so their existing lease-first path remains unchanged.
    const preparedMicrophone = options.voiceSessionId ? undefined : requestVoiceMicrophone();
    captureDebug('info', preparedMicrophone
      ? 'getUserMedia requested synchronously'
      : 'getUserMedia deferred until microphone lease is granted');
    // Create and resume Web Audio before the first await while this call still
    // belongs to the user's click/tap. Firefox may otherwise suspend a context
    // created after WebRTC signaling has consumed the transient activation.
    let captureContext: AudioContext;
    try {
      captureContext = new AudioContext();
      captureDebug('info', 'AudioContext created', {
        state: captureContext.state,
        sampleRate: captureContext.sampleRate,
      });
    } catch (error) {
      if (preparedMicrophone) stopVoiceMicrophoneWhenReady(preparedMicrophone);
      const reason = error instanceof Error ? error.message : String(error);
      captureDebug('error', 'AudioContext creation failed', { reason });
      throw new Error(`Could not create microphone audio context: ${reason}`);
    }
    try {
      const activated = await activateVoiceAudioContext(captureContext, preparedMicrophone);
      captureContext = activated.context;
      captureDebug('info', 'AudioContext running', {
        state: captureContext.state,
        sampleRate: captureContext.sampleRate,
        recoveredAfterTimeout: activated.recoveredAfterTimeout,
      });
    } catch (error) {
      void captureContext.close().catch(() => undefined);
      if (preparedMicrophone) stopVoiceMicrophoneWhenReady(preparedMicrophone);
      const reason = error instanceof Error ? error.message : String(error);
      captureDebug('error', 'AudioContext activation failed', {
        reason,
        state: captureContext.state,
      });
      throw new Error(`Could not activate microphone audio: ${reason}`);
    }
    // Establish on the user gesture with the mic acquired first, so Safari
    // exposes host candidates (the passive prewarm can't grab the mic on iOS).
    const ok = await ensure(true, preparedMicrophone);
    captureDebug(ok ? 'info' : 'error', ok
      ? 'streaming session ready for capture'
      : 'streaming session unavailable before capture');
    if (ok) {
      await sessionRef.current?.startUtterance(captureContext, preparedMicrophone);
      captureDebug('result', 'capture entered recording state');
    } else {
      void captureContext.close().catch(() => undefined);
      if (preparedMicrophone) stopVoiceMicrophoneWhenReady(preparedMicrophone);
    }
    return ok;
  }, [debug, enabled, ensure, options.voiceSessionId]);

  const stop = useCallback((opts: { releaseMic?: boolean; discard?: boolean } = {}) => {
    sessionRef.current?.stopUtterance(opts);
  }, []);

  const retryTranscription = useCallback(() => {
    sessionRef.current?.retryTranscription();
  }, []);

  const replayTranscription = useCallback(async (frames: ArrayBuffer[]): Promise<boolean> => {
    // Retry is initiated by an explicit button press. Acquire the mic while it
    // is still a user gesture so Safari can expose host ICE candidates for a
    // replacement P2P connection; replayUtterance releases it immediately.
    const ok = await ensure(true);
    return ok && !!sessionRef.current?.replayUtterance(frames);
  }, [ensure]);

  const interruptPlayback = useCallback(() => {
    sessionRef.current?.interruptPlayback();
  }, []);

  const disconnect = useCallback(() => {
    lifecycleGenerationRef.current++;
    sessionRef.current?.close();
    sessionRef.current = null;
    connectingRef.current = null;
    setState('idle');
    setInterim('');
  }, []);

  return {
    ready: state === 'ready' || state === 'recording',
    recording: state === 'recording',
    unavailable: state === 'unavailable',
    interim,
    error,
    ensure,
    start,
    stop,
    retryTranscription,
    replayTranscription,
    interruptPlayback,
    disconnect,
  };
}
