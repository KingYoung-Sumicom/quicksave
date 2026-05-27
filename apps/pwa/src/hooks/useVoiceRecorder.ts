// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Microphone capture via getUserMedia + MediaRecorder.
 *
 * `start()` requests mic permission and begins recording; `stop()` resolves
 * with the recorded audio Blob (and releases the mic track). `cancel()`
 * discards the recording. The hook owns no transcription logic — the caller
 * decides what to do with the Blob.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type RecorderState = 'idle' | 'recording';

export interface UseVoiceRecorder {
  state: RecorderState;
  /** False when the browser lacks MediaRecorder / getUserMedia. */
  isSupported: boolean;
  /** Last error (permission denied, no device, etc.), or null. */
  error: string | null;
  start: () => Promise<void>;
  /** Stops and resolves with the audio Blob, or null if nothing was captured. */
  stop: () => Promise<Blob | null>;
  cancel: () => void;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t));
}

export function useVoiceRecorder(): UseVoiceRecorder {
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const isSupported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined';

  const teardown = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  // Release the mic if the component unmounts mid-recording.
  useEffect(() => () => teardown(), [teardown]);

  const start = useCallback(async () => {
    if (!isSupported) {
      setError('Audio recording is not supported in this browser.');
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const mimeType = pickMimeType();
      // Speech recognition needs very little fidelity; a low mono bitrate keeps
      // the inline-base64 upload well under the single-frame cap (~512 KB →
      // several minutes at 24 kbps instead of ~30 s at the browser default).
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 24_000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.start();
      setState('recording');
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      setError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone permission denied.'
          : name === 'NotFoundError'
            ? 'No microphone found.'
            : 'Could not start recording.',
      );
      teardown();
      setState('idle');
    }
  }, [isSupported, teardown]);

  const stop = useCallback((): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      teardown();
      setState('idle');
      return Promise.resolve(null);
    }
    return new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        const blob = chunks.length > 0 ? new Blob(chunks, { type: recorder.mimeType }) : null;
        teardown();
        setState('idle');
        resolve(blob);
      };
      recorder.stop();
    });
  }, [teardown]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    teardown();
    setState('idle');
  }, [teardown]);

  return { state, isSupported, error, start, stop, cancel };
}
