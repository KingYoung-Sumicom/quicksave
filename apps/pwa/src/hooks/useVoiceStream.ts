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
  stop: (opts?: { releaseMic?: boolean }) => void;
  interruptPlayback: () => void;
}

export function useVoiceStream(
  agentId: string,
  onFinalText: (text: string) => void,
  onSpeechActivity?: (active: boolean) => void,
  onPartialText?: (text: string) => void,
  onRemotePlayback?: (active: boolean, streamId: string) => void,
  transportSessionId?: string,
): UseVoiceStream {
  const [state, setState] = useState<VoiceStreamState | 'idle'>('idle');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<VoiceStreamSession | null>(null);
  const connectingRef = useRef<Promise<boolean> | null>(null);
  const onFinalRef = useRef(onFinalText);
  onFinalRef.current = onFinalText;
  const onSpeechActivityRef = useRef(onSpeechActivity);
  onSpeechActivityRef.current = onSpeechActivity;
  const onPartialTextRef = useRef(onPartialText);
  onPartialTextRef.current = onPartialText;
  const onRemotePlaybackRef = useRef(onRemotePlayback);
  onRemotePlaybackRef.current = onRemotePlayback;

  useEffect(() => {
    return () => {
      sessionRef.current?.close();
      sessionRef.current = null;
    };
  }, []);

  const ensure = useCallback(async (acquireMic = false): Promise<boolean> => {
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
      const config = await getVoiceConfig();
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
      const session = new VoiceStreamSession(agentId, transportSessionId || crypto.randomUUID(), config, {
        onPartial: (text) => {
          setInterim(text);
          onPartialTextRef.current?.(text);
        },
        onFinal: (text) => {
          setInterim('');
          if (text) onFinalRef.current(text);
        },
        onSpeechActivity: (active) => onSpeechActivityRef.current?.(active),
        onRemotePlayback: (active, streamId) => onRemotePlaybackRef.current?.(active, streamId),
        onError: (message) => {
          setInterim('');
          setError(message);
        },
        onState: (s) => setState(s),
      });
      sessionRef.current = session;
      const ok = await session.connect({ acquireMic });
      if (!ok) {
        session.close();
        sessionRef.current = null;
      }
      return ok;
    })();

    connectingRef.current = connect;
    const result = await connect;
    connectingRef.current = null;
    return result;
  }, [agentId, state, transportSessionId]);

  const start = useCallback(async (): Promise<boolean> => {
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
  }, [ensure]);

  const stop = useCallback((opts: { releaseMic?: boolean } = {}) => {
    sessionRef.current?.stopUtterance(opts);
  }, []);

  const interruptPlayback = useCallback(() => {
    sessionRef.current?.interruptPlayback();
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
    interruptPlayback,
  };
}
