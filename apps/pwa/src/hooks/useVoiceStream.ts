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
  /** Connect if not already; returns true when ready. */
  ensure: () => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => void;
}

export function useVoiceStream(agentId: string, onFinalText: (text: string) => void): UseVoiceStream {
  const [state, setState] = useState<VoiceStreamState | 'idle'>('idle');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<VoiceStreamSession | null>(null);
  const connectingRef = useRef<Promise<boolean> | null>(null);
  const onFinalRef = useRef(onFinalText);
  onFinalRef.current = onFinalText;

  useEffect(() => {
    return () => {
      sessionRef.current?.close();
      sessionRef.current = null;
    };
  }, []);

  const ensure = useCallback(async (): Promise<boolean> => {
    if (sessionRef.current && (state === 'ready' || state === 'recording')) return true;
    if (connectingRef.current) return connectingRef.current;

    const connect = (async () => {
      const config = await getVoiceConfig();
      if (!isVoiceConfigUsable(config) || !agentId) {
        setState('unavailable');
        return false;
      }
      const session = new VoiceStreamSession(agentId, crypto.randomUUID(), config, {
        onPartial: (text) => setInterim(text),
        onFinal: (text) => {
          setInterim('');
          if (text) onFinalRef.current(text);
        },
        onError: (message) => {
          setInterim('');
          setError(message);
        },
        onState: (s) => setState(s),
      });
      sessionRef.current = session;
      const ok = await session.connect();
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
  }, [agentId, state]);

  const start = useCallback(async () => {
    setError(null);
    const ok = await ensure();
    if (ok) await sessionRef.current?.startUtterance();
  }, [ensure]);

  const stop = useCallback(() => {
    sessionRef.current?.stopUtterance();
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
  };
}
