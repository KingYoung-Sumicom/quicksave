// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * PWA-side WebRTC streaming voice client.
 *
 * Establishes a P2P WebRTC connection to the agent (signaling over the bus),
 * captures mic audio as 24 kHz PCM16 via an AudioWorklet, and ships raw frames
 * over a DataChannel. The agent bridges to a streaming ASR and pushes back
 * partial/final transcripts. No TURN is used — if the P2P connection can't be
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

// AudioWorklet processor: downsample the mic stream to the target rate and emit
// Int16 PCM frames. Kept as a string + Blob URL so it works regardless of the
// bundler's asset handling. Crude decimation (no anti-alias filter) — adequate
// for speech recognition; revisit if quality demands it.
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
        let s = Math.max(-1, Math.min(1, ch[i]));
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

  // Capture graph (created lazily per utterance).
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private workletUrl: string | null = null;

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
    } else if (msg.t === 'error') {
      this.cb.onError(msg.message);
    }
  }

  /** Begin an utterance: open the mic, start the ASR stream, pipe PCM frames. */
  async startUtterance(): Promise<void> {
    if (this.state !== 'ready' || !this.dc) return;
    // Reuse a stream already grabbed at connect() (the Safari ICE-gate path);
    // otherwise acquire it now (the prewarmed path that didn't need it up front).
    const stream = this.mediaStream ?? (await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS));
    this.mediaStream = stream;

    const ctx = new AudioContext();
    this.audioCtx = ctx;
    this.workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(this.workletUrl);

    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture', {
      processorOptions: { targetRate: VOICE_PCM_SAMPLE_RATE },
    });
    node.port.onmessage = (e) => {
      if (this.dc?.readyState === 'open') this.dc.send(e.data as ArrayBuffer);
    };
    source.connect(node);
    // Worklet needs a downstream node to be pulled; route to a muted gain.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);

    this.dcSend({ t: 'start', config: this.config, sampleRate: VOICE_PCM_SAMPLE_RATE });
    this.setState('recording');
  }

  /** End the current utterance: stop capture and ask the agent to finalize. */
  stopUtterance(): void {
    this.dcSend({ t: 'stop' });
    this.teardownCapture();
    if (this.state === 'recording') this.setState('ready');
  }

  private dcSend(msg: VoiceDcMessage): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(msg));
  }

  private teardownCapture(): void {
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
  }

  close(): void {
    this.teardownCapture();
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
    this.setState('closed');
  }
}
