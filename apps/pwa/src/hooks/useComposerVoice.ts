// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Shared voice-input logic for message composers (ClaudePanel + the new-session
 * view). Voice is streaming-only by design (WebRTC + realtime ASR): if a
 * machine doesn't advertise streaming, or the browser can't capture, the mic is
 * not shown; if the P2P link can't be established, the mic is disabled. There
 * is intentionally no record-then-send batch fallback.
 *
 * The hook owns the mic lifecycle + the "arming" state and feeds finalized
 * transcripts to the caller; the caller renders the button and decides where
 * transcript text goes (`onTranscript`) and how errors surface (`onError`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '../stores/connectionStore';
import { getVoiceConfig } from '../lib/secureStorage';
import { isVoiceConfigUsable } from '../lib/voiceTranscription';
import { useVoiceStream } from './useVoiceStream';

export interface UseComposerVoice {
  /** Whether to render the mic button at all (browser can capture + machine
   *  advertises streaming). */
  showMic: boolean;
  /** Press handler: starts or stops the live streaming utterance. */
  onMicPress: () => Promise<void>;
  /** True while a live utterance is streaming. */
  recording: boolean;
  /** True between press and capture actually starting (setup in progress). */
  arming: boolean;
  /** recording || arming — the button should reflect this as "busy". */
  busy: boolean;
  /** Live partial transcript for the in-progress utterance. */
  interim: string;
  /** True when a usable VoiceConfig is stored (for the idle tooltip). */
  configured: boolean;
  /** True while the live utterance is streaming (alias of `recording`; kept
   *  distinct for callers that show a streaming-specific caption). */
  streaming: boolean;
  /** Streaming P2P couldn't be established on this network (no TURN). The mic
   *  is shown but disabled, since there is no fallback. */
  unavailable: boolean;
}

// Browser capabilities required to capture + stream mic audio over WebRTC.
const browserCanCapture =
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof RTCPeerConnection !== 'undefined' &&
  typeof AudioContext !== 'undefined';

export function useComposerVoice(
  agentId: string,
  onTranscript: (text: string) => void,
  onError: (message: string) => void,
): UseComposerVoice {
  const agentAudio = useConnectionStore((s) => (agentId ? s.agentConnections[agentId]?.audio : undefined));
  const streamingSupported = !!agentAudio?.streaming;

  const voiceStream = useVoiceStream(agentId, onTranscript);

  const [configured, setConfigured] = useState(false);
  const [arming, setArming] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest onError without re-subscribing effects on every parent render.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    getVoiceConfig().then((c) => { if (!cancelled) setConfigured(isVoiceConfigUsable(c)); });
    return () => { cancelled = true; };
  }, []);

  // Prewarm the WebRTC link so the first utterance starts instantly — only when
  // the machine advertised streaming support.
  useEffect(() => {
    if (!agentId || !streamingSupported) return;
    void getVoiceConfig().then((c) => { if (isVoiceConfigUsable(c)) void voiceStream.ensure(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, streamingSupported]);

  useEffect(() => {
    if (voiceStream.error) onErrorRef.current(voiceStream.error);
  }, [voiceStream.error]);

  useEffect(() => () => { if (armTimerRef.current) clearTimeout(armTimerRef.current); }, []);

  const stopArming = useCallback(() => {
    if (armTimerRef.current) { clearTimeout(armTimerRef.current); armTimerRef.current = null; }
    setArming(false);
  }, []);

  const onMicPress = useCallback(async () => {
    if (arming) return;
    if (voiceStream.recording) { voiceStream.stop(); return; }
    // No streaming link → nothing to do (the button is disabled in this state,
    // but guard anyway).
    if (!voiceStream.ready) {
      onErrorRef.current('Live voice couldn’t connect on this network.');
      return;
    }

    const config = await getVoiceConfig();
    if (!isVoiceConfigUsable(config)) {
      setConfigured(false);
      onErrorRef.current('Voice transcription is not configured. Set it up in Settings.');
      return;
    }
    setConfigured(true);
    armTimerRef.current = setTimeout(() => setArming(true), 120);
    try {
      await voiceStream.start();
    } catch (err) {
      onErrorRef.current(err instanceof Error ? err.message : 'Could not start voice input.');
    } finally {
      stopArming();
    }
  }, [arming, voiceStream, stopArming]);

  return {
    showMic: browserCanCapture && streamingSupported,
    onMicPress,
    recording: voiceStream.recording,
    arming,
    busy: arming,
    interim: voiceStream.interim,
    configured,
    streaming: voiceStream.recording,
    unavailable: voiceStream.unavailable,
  };
}
