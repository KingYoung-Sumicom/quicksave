// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Shared voice-input logic for message composers (ClaudePanel + the new-session
 * view). Owns the mic lifecycle: streaming-first (WebRTC) with batch fallback,
 * the "arming" state, capability gating from the agent handshake, and feeding
 * finalized transcripts back to the caller. The caller renders the button and
 * decides where transcript text goes (`onTranscript`) and how errors surface
 * (`onError`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '../stores/connectionStore';
import { getVoiceConfig } from '../lib/secureStorage';
import { transcribeViaAgent, isVoiceConfigUsable } from '../lib/voiceTranscription';
import { useVoiceRecorder } from './useVoiceRecorder';
import { useVoiceStream } from './useVoiceStream';

export interface UseComposerVoice {
  /** Whether to render the mic button at all (browser mic + machine declared support). */
  showMic: boolean;
  /** Press handler: starts/stops streaming or batch capture. */
  onMicPress: () => Promise<void>;
  /** True while live streaming or batch recording. */
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
  /** True when this is a live-streaming utterance (vs batch). */
  streaming: boolean;
}

export function useComposerVoice(
  agentId: string,
  onTranscript: (text: string) => void,
  onError: (message: string) => void,
): UseComposerVoice {
  const agentAudio = useConnectionStore((s) => (agentId ? s.agentConnections[agentId]?.audio : undefined));
  const streamingSupported = !!agentAudio?.streaming;
  const batchSupported = !!agentAudio?.transcription;
  const voiceSupported = streamingSupported || batchSupported;

  const recorder = useVoiceRecorder();
  const voiceStream = useVoiceStream(agentId, onTranscript);

  const [configured, setConfigured] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
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

  const onMicPress = useCallback(async () => {
    if (transcribing || arming) return;
    if (voiceStream.recording) { voiceStream.stop(); return; }
    if (recorder.state === 'recording') { await batchStopAndTranscribe(); return; }

    const config = await getVoiceConfig();
    if (!isVoiceConfigUsable(config)) {
      setConfigured(false);
      onErrorRef.current('Voice transcription is not configured. Set it up in Settings.');
      return;
    }
    setConfigured(true);
    armTimerRef.current = setTimeout(() => setArming(true), 120);
    try {
      if (streamingSupported && voiceStream.ready) {
        await voiceStream.start();
        return;
      }
      if (batchSupported) {
        await recorder.start();
        return;
      }
      onErrorRef.current('Voice is not supported on this machine.');
    } finally {
      stopArming();
    }
  }, [transcribing, arming, voiceStream, recorder, batchStopAndTranscribe, streamingSupported, batchSupported, stopArming]);

  const recording = voiceStream.recording || recorder.state === 'recording';

  return {
    showMic: recorder.isSupported && voiceSupported,
    onMicPress,
    recording,
    arming,
    transcribing,
    busy: transcribing || arming,
    interim: voiceStream.interim,
    configured,
    streaming: voiceStream.recording,
  };
}
