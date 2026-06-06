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
import type { VoiceAgentEvent, VoiceAgentState } from '@sumicom/quicksave-shared';
import { getVoiceConfig } from '../lib/secureStorage';
import { getBusForAgent } from '../lib/busRegistry';
import {
  attachVoiceAgent,
  detachVoiceAgent,
  sendVoiceAgentUtterance,
  fetchVoiceAgentAudio,
} from '../lib/voiceAgentClient';
import { VoiceOutput } from '../lib/voiceOutput';
import { useComposerVoice } from './useComposerVoice';

export interface UseVoiceAgent {
  enabled: boolean;
  toggle: () => void;
  /** Brain configured AND session live — i.e. the agent will actually respond. */
  active: boolean;
  state: VoiceAgentState;
  lastSpoken: string;
  actionLog: string[];
  error: string | null;
  // Talk affordance — reuses the existing composer mic (both STT modes).
  onTalkPress: () => void;
  recording: boolean;
  interim: string;
  busy: boolean;
  showMic: boolean;
}

export function useVoiceAgent(agentId: string, sessionId: string | undefined): UseVoiceAgent {
  const [enabled, setEnabled] = useState(false);
  const [active, setActive] = useState(false);
  const [state, setState] = useState<VoiceAgentState>('idle');
  const [lastSpoken, setLastSpoken] = useState('');
  const [actionLog, setActionLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const outputRef = useRef<VoiceOutput | null>(null);

  const onTranscript = useCallback(
    (text: string) => {
      if (!sessionId) return;
      outputRef.current?.interrupt(); // barge-in: cut the agent off when the user speaks
      setError(null);
      void sendVoiceAgentUtterance(agentId, sessionId, text).catch((e) =>
        setError(String(e?.message ?? e)),
      );
    },
    [agentId, sessionId],
  );

  const voice = useComposerVoice(agentId, onTranscript, setError);

  // Barge-in the instant recording starts, not only when the transcript lands.
  useEffect(() => {
    if (voice.recording) outputRef.current?.interrupt();
  }, [voice.recording]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let cancelled = false;
    let unsub: (() => void) | undefined;
    const output = new VoiceOutput((audioId) => fetchVoiceAgentAudio(agentId, sessionId, audioId));
    outputRef.current = output;
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
        const res = await attachVoiceAgent(agentId, sessionId, cfg);
        if (cancelled) return;
        setActive(!!res.active);
        if (!res.active) setError(res.error ?? '語音 agent 模型未設定，或 session 未啟動。');
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
              break;
            case 'speak':
              setLastSpoken(ev.text);
              output.enqueue(ev.audioId);
              break;
            case 'action':
              setActionLog((log) => [...log.slice(-19), ev.summary]);
              break;
            case 'error':
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
      output.dispose();
      outputRef.current = null;
      setActive(false);
      void detachVoiceAgent(agentId, sessionId);
    };
  }, [enabled, sessionId, agentId]);

  const toggle = useCallback(() => setEnabled((e) => !e), []);

  return {
    enabled,
    toggle,
    active,
    state,
    lastSpoken,
    actionLog,
    error,
    onTalkPress: voice.onMicPress,
    recording: voice.recording,
    interim: voice.interim,
    busy: voice.busy,
    showMic: voice.showMic,
  };
}
