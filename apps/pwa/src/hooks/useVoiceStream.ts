// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * React wrapper around `VoiceStreamSession`. Lazily establishes the WebRTC
 * connection on first use (`ensure`), exposes recording state + the live
 * interim transcript, and reports `unavailable` when P2P can't be set up so
 * the caller can fall back to batch transcription.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getVoiceConfig } from '../lib/secureStorage';
import { isVoiceConfigUsable } from '../lib/voiceTranscription';
import { VoiceStreamSession, type VoiceStreamState } from '../lib/voiceStreamClient';

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
    if (enabled) return;
    lifecycleGenerationRef.current++;
    sessionRef.current?.close();
    sessionRef.current = null;
    connectingRef.current = null;
    setState('idle');
    setInterim('');
  }, [enabled]);

  const ensure = useCallback(async (acquireMic = false): Promise<boolean> => {
    if (!enabled) return false;
    if (sessionRef.current && (state === 'ready' || state === 'recording')) return true;
    if (connectingRef.current) {
      // A connect is already in flight (typically the passive prewarm). Wait for
      // it: reuse it if it produced a ready session; otherwise fall through and
      // retry — acquiring the mic this time if the gesture asked for it. The
      // prewarm can't grab the mic, so on iOS its attempt always fails, and a
      // tap landing inside that window must not inherit the doomed result.
      const inflight = await connectingRef.current;
      if (inflight && sessionRef.current) return true;
      if (!acquireMic) return inflight;
    }

    const connect = (async () => {
      const generation = lifecycleGenerationRef.current;
      const config = await getVoiceConfig();
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
      }, undefined, options.voiceSessionId);
      sessionRef.current = session;
      const ok = await session.connect({ acquireMic });
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
  }, [agentId, enabled, state, options.transportSessionId, options.voiceSessionId]);

  const start = useCallback(async (): Promise<boolean> => {
    if (!enabled) return false;
    setError(null);
    // Create and resume Web Audio before the first await while this call still
    // belongs to the user's click/tap. Firefox may otherwise suspend a context
    // created after WebRTC signaling has consumed the transient activation.
    const captureContext = new AudioContext();
    try {
      if (captureContext.state === 'suspended') await captureContext.resume();
      if (captureContext.state !== 'running') {
        throw new Error(`Microphone audio context did not start (state: ${captureContext.state}).`);
      }
    } catch (error) {
      void captureContext.close().catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not activate microphone audio: ${reason}`);
    }
    // Establish on the user gesture with the mic acquired first, so Safari
    // exposes host candidates (the passive prewarm can't grab the mic on iOS).
    const ok = await ensure(true);
    if (ok) {
      await sessionRef.current?.startUtterance(captureContext);
    } else {
      void captureContext.close().catch(() => undefined);
    }
    return ok;
  }, [enabled, ensure]);

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
