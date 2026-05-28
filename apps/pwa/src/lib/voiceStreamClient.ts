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

export type VoiceStreamState = 'connecting' | 'ready' | 'recording' | 'unavailable' | 'closed';

export interface VoiceStreamCallbacks {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(message: string): void;
  onState(state: VoiceStreamState): void;
}

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

  constructor(
    private readonly agentId: string,
    private readonly sessionId: string,
    private readonly config: VoiceConfig,
    private readonly cb: VoiceStreamCallbacks,
  ) {}

  getState(): VoiceStreamState {
    return this.state;
  }

  private setState(s: VoiceStreamState) {
    if (this.state === s) return;
    this.state = s;
    this.cb.onState(s);
  }

  /** Establish the WebRTC connection. Resolves true if ready, false if P2P
   *  could not be established (caller should fall back to batch). */
  async connect(): Promise<boolean> {
    const bus = getBusForAgent(this.agentId);
    if (!bus || typeof RTCPeerConnection === 'undefined') {
      this.setState('unavailable');
      return false;
    }

    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URL }] });
    this.pc = pc;
    const dc = pc.createDataChannel('voice', { ordered: true });
    dc.binaryType = 'arraybuffer';
    this.dc = dc;

    dc.onmessage = (e) => this.handleDcMessage(e.data);

    pc.onicecandidate = (e) => {
      const candidate = e.candidate ? JSON.stringify(e.candidate.toJSON()) : null;
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
        this.setState('ready');
        finish(true);
      };
      pc.onconnectionstatechange = () => {
        // 'disconnected' is transient per WebRTC spec (can recover), and we
        // call close() ourselves which already moves state to 'closed' — so
        // only treat 'failed' as a genuine, terminal teardown.
        if (pc.connectionState === 'failed') {
          this.setState('unavailable');
          finish(false);
        }
      };
      setTimeout(() => {
        if (this.state !== 'ready') {
          this.setState('unavailable');
          finish(false);
        }
      }, CONNECT_TIMEOUT_MS);
    });

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await bus.command<VoiceRtcConnectResponsePayload, VoiceRtcConnectRequestPayload>(
        'voice:rtc-connect',
        { sessionId: this.sessionId, sdp: offer.sdp ?? '' },
        { timeoutMs: 15_000 },
      );
      if (res.error || !res.sdp) {
        this.setState('unavailable');
        return false;
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: res.sdp });
    } catch {
      this.setState('unavailable');
      return false;
    }

    return ready;
  }

  private applyRemoteIce(d: VoiceRtcIceUpdate | undefined): void {
    if (!d || !d.candidate || !this.pc) return;
    try {
      void this.pc.addIceCandidate(JSON.parse(d.candidate));
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
    } else if (msg.t === 'error') {
      this.cb.onError(msg.message);
    }
  }

  /** Begin an utterance: open the mic, start the ASR stream, pipe PCM frames. */
  async startUtterance(): Promise<void> {
    if (this.state !== 'ready' || !this.dc) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
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
