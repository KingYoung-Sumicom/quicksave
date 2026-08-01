// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * PWA-side WebRTC streaming voice client.
 *
 * Establishes a P2P WebRTC connection to the agent (signaling over the bus),
 * negotiates an inbound TTS audio track, and uses a DataChannel for ASR PCM plus
 * VAD/transcript/playback control. The agent sends TTS as a remote track. No
 * TURN is used — if the P2P connection can't be
 * established within a timeout, the session reports `unavailable` and the
 * caller falls back to batch transcription.
 */
import {
  VOICE_PCM_SAMPLE_RATE,
  type VoiceConfig,
  type VoiceDcMessage,
  type VoiceRtcConnectRequestPayload,
  type VoiceRtcConnectResponsePayload,
  type VoiceRtcIceRequestPayload,
  type VoiceRtcIceUpdate,
} from '@sumicom/quicksave-shared';
import { getBusForAgent } from './busRegistry';

const STUN_URL = 'stun:stun.l.google.com:19302';
const CONNECT_TIMEOUT_MS = 8_000;
const CAPTURE_FIRST_FRAME_TIMEOUT_MS = 1_000;

// Mic capture constraints (mono + light DSP), shared by the connect-time
// permission grab (Safari ICE gate) and per-utterance capture.
const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};

export type VoiceStreamState = 'connecting' | 'ready' | 'recording' | 'unavailable' | 'closed';

export interface VoiceStreamCallbacks {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onSpeechActivity?(active: boolean): void;
  onRemotePlayback?(active: boolean, streamId: string): void;
  onError(message: string): void;
  onState(state: VoiceStreamState): void;
}

// ── WebRTC debug instrumentation ────────────────────────────────────────────

export type IceCandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'mdns' | 'unknown';

/**
 * Classify an ICE candidate from its SDP `candidate:` line. mDNS host
 * candidates (`*.local`) are called out specifically: Safari/iOS only exposes
 * real host candidates after a mic grant, so a gathering that yields ONLY mDNS
 * candidates is the classic "same-LAN P2P never connects" signature. A run with
 * no `srflx` (server-reflexive) candidate means STUN didn't return a public
 * mapping — cross-NAT P2P will then fail (there's no TURN fallback).
 */
export function classifyIceCandidate(candidate: string): IceCandidateType {
  if (/\.local(\s|$)/i.test(candidate)) return 'mdns';
  const m = /\btyp\s+(\w+)/i.exec(candidate);
  switch (m?.[1]?.toLowerCase()) {
    case 'host': return 'host';
    case 'srflx': return 'srflx';
    case 'prflx': return 'prflx';
    case 'relay': return 'relay';
    default: return 'unknown';
  }
}

export interface VoiceRtcDebugEvent {
  /** Milliseconds since the test started. */
  t: number;
  kind: 'info' | 'local-candidate' | 'remote-candidate' | 'pc-state' | 'dc' | 'sdp' | 'result' | 'error';
  detail: string;
  data?: Record<string, unknown>;
}

export type VoiceRtcDebugObserver = (event: VoiceRtcDebugEvent) => void;

// Keep ASR ingress on the proven PCM/DataChannel path while outbound TTS uses
// a WebRTC media track. RTP microphone ingress remains available agent-side
// for a future browser-validated transport switch.
const WORKLET_SRC = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = sampleRate / options.processorOptions.targetRate;
    this._acc = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const out = [];
    for (let i = 0; i < ch.length; i++) {
      this._acc += 1;
      if (this._acc >= this.ratio) {
        this._acc -= this.ratio;
        const s = Math.max(-1, Math.min(1, ch[i]));
        out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      }
    }
    if (out.length) {
      const buf = new Int16Array(out);
      this.port.postMessage(buf.buffer, [buf.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

export class VoiceStreamSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private unsubIce: (() => void) | null = null;
  private state: VoiceStreamState = 'connecting';
  private remoteAudio: HTMLAudioElement | null = null;
  private remoteAudioTrack: MediaStreamTrack | null = null;
  private remoteAudioStream: MediaStream | null = null;
  private remotePlaybackActive = false;
  private remotePlaybackNotified = false;
  private remotePlaybackStreamId = '';
  private audioCtx: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private captureSink: GainNode | null = null;
  private workletUrl: string | null = null;

  // The mic stream stays granted between utterances in voice-agent mode. ASR
  // reads it through Web Audio; the peer transceiver is recvonly for TTS.
  private mediaStream: MediaStream | null = null;

  // Debug instrumentation (no-op unless an observer is supplied).
  private debugStart = 0;

  constructor(
    private readonly agentId: string,
    private readonly sessionId: string,
    private readonly config: VoiceConfig,
    private readonly cb: VoiceStreamCallbacks,
    private readonly onDebug?: VoiceRtcDebugObserver,
  ) {}

  getState(): VoiceStreamState {
    return this.state;
  }

  private setState(s: VoiceStreamState) {
    if (this.state === s) return;
    this.state = s;
    this.cb.onState(s);
  }

  private dbg(kind: VoiceRtcDebugEvent['kind'], detail: string, data?: Record<string, unknown>): void {
    if (!this.onDebug) return;
    const t = this.debugStart ? Math.round(performance.now() - this.debugStart) : 0;
    this.onDebug({ t, kind, detail, data });
  }

  /** Best-effort snapshot of the selected ICE candidate pair + RTT for the
   *  debug panel. Returns null when no pair has succeeded yet. */
  async getDebugStats(): Promise<Record<string, unknown> | null> {
    if (!this.pc) return null;
    try {
      const report = await this.pc.getStats();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let pair: any = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const byId = new Map<string, any>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      report.forEach((s: any) => {
        byId.set(s.id, s);
        if (s.type === 'candidate-pair' && (s.nominated || s.selected || s.state === 'succeeded')) pair = s;
      });
      if (!pair) return { note: 'no succeeded candidate pair' };
      const l = byId.get(pair.localCandidateId);
      const r = byId.get(pair.remoteCandidateId);
      return {
        state: pair.state,
        rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : undefined,
        local: l ? `${l.candidateType} ${l.protocol ?? ''}`.trim() : pair.localCandidateId,
        remote: r ? `${r.candidateType} ${r.protocol ?? ''}`.trim() : pair.remoteCandidateId,
        bytesSent: pair.bytesSent,
        bytesReceived: pair.bytesReceived,
      };
    } catch {
      return null;
    }
  }

  /** Establish the WebRTC connection. Resolves true if ready, false if P2P
   *  could not be established (caller should fall back to batch). */
  async connect(opts: { acquireMic?: boolean } = {}): Promise<boolean> {
    this.debugStart = performance.now();
    this.dbg('info', `connect start (acquireMic=${!!opts.acquireMic})`);
    const bus = getBusForAgent(this.agentId);
    if (!bus || typeof RTCPeerConnection === 'undefined') {
      this.dbg('result', `unavailable: ${!bus ? 'not connected to an agent' : 'WebRTC not supported in this browser'}`);
      this.setState('unavailable');
      return false;
    }

    // Safari/WebKit withholds real host ICE candidates until the page holds a
    // mic permission grant, so a data-channel-only offer created *before*
    // getUserMedia only yields mDNS host candidates the native (wrtc) answerer
    // can't resolve — same-LAN P2P then never connects. When establishing from
    // a user gesture, grab the mic before building the offer so host candidates
    // are exposed. getUserMedia needs a user activation on iOS, so this runs
    // only on the tap path (not the passive prewarm, which omits acquireMic).
    // The stream is reused by the first utterance.
    if (opts.acquireMic && !this.mediaStream) {
      this.dbg('info', 'requesting mic (getUserMedia) before building the offer');
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        this.dbg('info', 'mic granted');
      } catch {
        this.dbg('result', 'unavailable: mic permission denied/unavailable');
        this.setState('unavailable');
        return false;
      }
    }

    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URL }] });
    this.pc = pc;
    this.dbg('info', `RTCPeerConnection created (STUN ${STUN_URL})`);
    this.instrumentPc(pc);
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (event) => this.attachRemoteAudio(event.track, event.streams[0]);
    const dc = pc.createDataChannel('voice', { ordered: true });
    dc.binaryType = 'arraybuffer';
    this.dc = dc;
    if (this.onDebug) {
      dc.addEventListener('open', () => this.dbg('dc', 'DataChannel open'));
      dc.addEventListener('close', () => this.dbg('dc', 'DataChannel close'));
      dc.addEventListener('error', () => this.dbg('dc', 'DataChannel error'));
    }

    dc.onmessage = (e) => this.handleDcMessage(e.data);

    pc.onicecandidate = (e) => {
      const candidate = e.candidate ? JSON.stringify(e.candidate.toJSON()) : null;
      if (e.candidate) {
        const type = classifyIceCandidate(e.candidate.candidate ?? '');
        this.dbg('local-candidate', type, { type, candidate: e.candidate.candidate });
      } else {
        this.dbg('info', 'local ICE gathering complete');
      }
      void bus
        .command<unknown, VoiceRtcIceRequestPayload>('voice:rtc-ice', { sessionId: this.sessionId, candidate })
        .catch(() => {});
    };

    // Agent's trickled ICE candidates arrive on this subscription.
    this.unsubIce = bus.subscribe<VoiceRtcIceUpdate, VoiceRtcIceUpdate>(`/voice/rtc/${this.sessionId}`, {
      onSnapshot: (d) => this.applyRemoteIce(d),
      onUpdate: (d) => this.applyRemoteIce(d),
    });

    const ready = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      dc.onopen = () => {
        this.dbg('result', 'ready: DataChannel open');
        this.setState('ready');
        finish(true);
      };
      pc.onconnectionstatechange = () => {
        // 'disconnected' is transient per WebRTC spec (can recover), and we
        // call close() ourselves which already moves state to 'closed' — so
        // only treat 'failed' as a genuine, terminal teardown.
        if (pc.connectionState === 'failed') {
          this.dbg('result', 'unavailable: connectionState=failed (no working candidate pair — likely NAT with no TURN)');
          this.setState('unavailable');
          finish(false);
        }
      };
      setTimeout(() => {
        if (this.state !== 'ready') {
          this.dbg('result', `unavailable: timed out after ${CONNECT_TIMEOUT_MS}ms (state=${this.state})`);
          this.setState('unavailable');
          finish(false);
        }
      }, CONNECT_TIMEOUT_MS);
    });

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.dbg('sdp', `local offer set (${offer.sdp?.length ?? 0} bytes)`);
      const res = await bus.command<VoiceRtcConnectResponsePayload, VoiceRtcConnectRequestPayload>(
        'voice:rtc-connect',
        { sessionId: this.sessionId, sdp: offer.sdp ?? '' },
        { timeoutMs: 15_000 },
      );
      if (res.error || !res.sdp) {
        this.dbg('result', `unavailable: agent ${res.error ? `error: ${res.error}` : 'returned no SDP answer'}`);
        this.setState('unavailable');
        return false;
      }
      this.dbg('sdp', `remote answer set (${res.sdp.length} bytes)`);
      await pc.setRemoteDescription({ type: 'answer', sdp: res.sdp });
    } catch {
      this.dbg('result', 'unavailable: signaling exception (createOffer/setDescription/command threw)');
      this.setState('unavailable');
      return false;
    }

    return ready;
  }

  /** Attach debug-only state listeners (additive — never clobbers the `onX`
   *  handlers the connect path sets). No-op without a debug observer. */
  private instrumentPc(pc: RTCPeerConnection): void {
    if (!this.onDebug) return;
    pc.addEventListener('iceconnectionstatechange', () => this.dbg('pc-state', `iceConnectionState=${pc.iceConnectionState}`));
    pc.addEventListener('icegatheringstatechange', () => this.dbg('pc-state', `iceGatheringState=${pc.iceGatheringState}`));
    pc.addEventListener('signalingstatechange', () => this.dbg('pc-state', `signalingState=${pc.signalingState}`));
    pc.addEventListener('connectionstatechange', () => this.dbg('pc-state', `connectionState=${pc.connectionState}`));
  }

  private applyRemoteIce(d: VoiceRtcIceUpdate | undefined): void {
    if (!d || !d.candidate || !this.pc) return;
    try {
      const init = JSON.parse(d.candidate) as { candidate?: string };
      if (this.onDebug) {
        const type = classifyIceCandidate(init.candidate ?? '');
        this.dbg('remote-candidate', type, { type, candidate: init.candidate });
      }
      void this.pc.addIceCandidate(init);
    } catch {
      /* ignore malformed candidate */
    }
  }

  private handleDcMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: VoiceDcMessage;
    try {
      msg = JSON.parse(data) as VoiceDcMessage;
    } catch {
      return;
    }
    if (msg.t === 'transcript') {
      if (msg.final) this.cb.onFinal(msg.text);
      else this.cb.onPartial(msg.text);
    } else if (msg.t === 'speech') {
      this.cb.onSpeechActivity?.(msg.active);
    } else if (msg.t === 'playback') {
      this.handleRemotePlayback(msg.active, msg.streamId);
    } else if (msg.t === 'error') {
      this.cb.onError(msg.message);
    }
  }

  /** Begin an utterance and send proven Worklet PCM frames for ASR. */
  async startUtterance(preparedContext?: AudioContext): Promise<void> {
    if (this.state !== 'ready' || !this.dc) return;
    // Reuse a stream already grabbed at connect() (the Safari ICE-gate path);
    // otherwise acquire it now (the prewarmed path that didn't need it up front).
    const stream = this.mediaStream ?? (await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS));
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('Microphone audio track is unavailable.');

    let startSent = false;
    try {
      const ctx = preparedContext ?? new AudioContext();
      this.audioCtx = ctx;
      if (ctx.state === 'suspended') {
        this.dbg('info', 'resuming suspended microphone AudioContext');
        await ctx.resume();
      }
      if (ctx.state !== 'running') {
        throw new Error(`Microphone audio context did not start (state: ${ctx.state}).`);
      }
      this.workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(this.workletUrl);
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-capture', {
        processorOptions: { targetRate: VOICE_PCM_SAMPLE_RATE },
      });
      source.connect(node);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink).connect(ctx.destination);
      this.captureSource = source;
      this.captureNode = node;
      this.captureSink = sink;
      this.mediaStream = stream;

      const firstFrame = new Promise<void>((resolve, reject) => {
        let received = false;
        const timeout = setTimeout(() => {
          if (received) return;
          reject(new Error('Microphone started but produced no audio frames.'));
        }, CAPTURE_FIRST_FRAME_TIMEOUT_MS);
        node.port.onmessage = (event) => {
          if (this.dc?.readyState === 'open') this.dc.send(event.data as ArrayBuffer);
          if (received) return;
          received = true;
          clearTimeout(timeout);
          resolve();
        };
      });

      this.dcSend({
        t: 'start',
        config: this.config,
        sampleRate: VOICE_PCM_SAMPLE_RATE,
        audioTransport: 'datachannel',
      });
      startSent = true;
      await firstFrame;
    } catch (error) {
      if (startSent) this.dcSend({ t: 'stop' });
      this.teardownCapture({ releaseMic: true });
      const reason = error instanceof Error ? error.message : String(error);
      this.dbg('error', 'microphone capture failed to start', { reason });
      throw new Error(`Could not start microphone capture: ${reason}`);
    }
    this.setState('recording');
  }

  /** End the current utterance: stop capture and ask the agent to finalize.
   *  Voice-agent continuous listening keeps the granted mic stream alive so the
   *  next utterance can start during assistant speech without a permission gap. */
  stopUtterance(opts: { releaseMic?: boolean } = {}): void {
    this.dcSend({ t: 'stop' });
    this.teardownCapture({ releaseMic: opts.releaseMic ?? true });
    if (this.state === 'recording') this.setState('ready');
  }

  /** Stop the agent's current outbound TTS after barge-in is confirmed. */
  interruptPlayback(): void {
    this.dcSend({ t: 'interrupt-playback' });
  }

  private dcSend(msg: VoiceDcMessage): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(msg));
  }

  private teardownCapture(opts: { releaseMic?: boolean } = {}): void {
    if (this.captureNode) this.captureNode.port.onmessage = null;
    try {
      this.captureSource?.disconnect();
      this.captureNode?.disconnect();
      this.captureSink?.disconnect();
    } catch {
      /* graph may already be disconnected */
    }
    this.captureSource = null;
    this.captureNode = null;
    this.captureSink = null;
    if (opts.releaseMic !== false) {
      this.mediaStream?.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
  }

  private attachRemoteAudio(track: MediaStreamTrack, stream?: MediaStream): void {
    if (track.kind !== 'audio') return;
    track.enabled = true;
    this.remoteAudioTrack = track;
    this.remoteAudioStream = stream ?? null;
  }

  private handleRemotePlayback(active: boolean, streamId: string): void {
    this.remotePlaybackActive = active;
    this.remotePlaybackStreamId = active ? streamId : '';
    if (!active) {
      const wasNotified = this.remotePlaybackNotified;
      this.remotePlaybackNotified = false;
      // Always send the end marker so waiting cues can settle even when play()
      // was rejected before an active marker reached the hook.
      this.cb.onRemotePlayback?.(false, streamId);
      if (!wasNotified) this.dbg('error', 'remote TTS ended before browser playback started');
      this.releaseRemoteAudioElement();
      return;
    }

    if (!this.remoteAudioTrack) {
      this.cb.onError('Remote voice track is unavailable in the browser.');
      this.cb.onRemotePlayback?.(false, streamId);
      return;
    }
    const el = new Audio();
    el.autoplay = false;
    el.muted = false;
    el.volume = 1;
    el.setAttribute('playsinline', '');
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'fixed',
      width: '1px',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none',
    });
    el.srcObject = this.remoteAudioStream ?? new MediaStream([this.remoteAudioTrack]);
    document.body.appendChild(el);
    this.remoteAudio = el;
    void el.play().then(() => {
      if (!this.remotePlaybackActive || this.remotePlaybackStreamId !== streamId) return;
      this.remotePlaybackNotified = true;
      this.cb.onRemotePlayback?.(true, streamId);
      this.dbg('info', 'remote TTS audio element playing');
    }).catch((error) => {
      if (!this.remotePlaybackActive || this.remotePlaybackStreamId !== streamId) return;
      const reason = error instanceof Error ? error.message : String(error);
      this.dbg('error', 'remote TTS play() rejected', { reason });
      this.cb.onError(`Browser blocked remote voice playback: ${reason}`);
      this.cb.onRemotePlayback?.(false, streamId);
      this.releaseRemoteAudioElement();
    });
  }

  private releaseRemoteAudioElement(): void {
    if (!this.remoteAudio) return;
    this.remoteAudio.pause();
    this.remoteAudio.srcObject = null;
    this.remoteAudio.remove();
    this.remoteAudio = null;
  }

  close(): void {
    this.teardownCapture({ releaseMic: true });
    this.unsubIce?.();
    this.unsubIce = null;
    try {
      this.dc?.close();
      this.pc?.close();
    } catch {
      /* already closed */
    }
    this.dc = null;
    this.pc = null;
    this.releaseRemoteAudioElement();
    this.remoteAudioTrack = null;
    this.remoteAudioStream = null;
    this.remotePlaybackActive = false;
    this.remotePlaybackNotified = false;
    this.remotePlaybackStreamId = '';
    this.setState('closed');
  }
}
