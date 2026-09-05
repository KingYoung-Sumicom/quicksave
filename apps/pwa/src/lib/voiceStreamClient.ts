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
  type VoiceRtcMicrophoneLeaseRequestPayload,
  type VoiceRtcMicrophoneLeaseResponsePayload,
} from '@sumicom/quicksave-shared';
import { getBusForAgent } from './busRegistry';

const STUN_URL = 'stun:stun.l.google.com:19302';
const CONNECT_TIMEOUT_MS = 8_000;
const CAPTURE_FIRST_FRAME_TIMEOUT_MS = 2_500;
const MICROPHONE_CLAIM_TIMEOUT_MS = 3_000;
export const MICROPHONE_START_TIMEOUT_MS = 12_000;

// Mic capture constraints (mono + light DSP), shared by the connect-time
// permission grab (Safari ICE gate) and per-utterance capture.
const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};

export function requestVoiceMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
}

export function stopVoiceMicrophoneWhenReady(streamPromise: Promise<MediaStream>): void {
  void streamPromise.then((stream) => {
    stream.getTracks().forEach((track) => track.stop());
  }).catch(() => undefined);
}

export async function acquireVoiceMicrophone(
  streamPromise: Promise<MediaStream> = requestVoiceMicrophone(),
): Promise<MediaStream> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timed = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      stopVoiceMicrophoneWhenReady(streamPromise);
      reject(new Error('Microphone permission request timed out. Please tap the microphone again.'));
    }, MICROPHONE_START_TIMEOUT_MS);
  });
  try {
    return await Promise.race([streamPromise, timed]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export type VoiceStreamState = 'connecting' | 'ready' | 'recording' | 'unavailable' | 'closed';

export interface VoiceStreamCallbacks {
  onPartial(text: string): void;
  onFinal(text: string): void;
  /** PCM accepted by the local capture graph, before transport. This lets the
   * caller retain a recovery copy even if the P2P link later fails. */
  onAudioFrame?(pcm: ArrayBuffer): void;
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

export function shouldUseLegacyPcmCapture(userAgent: string, maxTouchPoints = 0): boolean {
  // Firefox can leave the Worklet graph unpulled. iOS/iPadOS WebKit has a
  // separate intermittent failure where getUserMedia succeeds and the track
  // stays live, but AudioWorklet never processes a frame. ScriptProcessor is
  // deprecated but remains the reliable realtime PCM path on both engines.
  const ios = /iP(?:hone|ad|od)/i.test(userAgent);
  const ipadDesktopUa = /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
  return /Firefox\//i.test(userAgent) || ios || ipadDesktopUa;
}

function downsampleFloatPcm(input: Float32Array, sourceRate: number): ArrayBuffer {
  const ratio = sourceRate / VOICE_PCM_SAMPLE_RATE;
  const output = new Int16Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let i = 0; i < output.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[Math.min(input.length - 1, Math.floor(i * ratio))] ?? 0));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

function microphoneTrackDebugData(track: MediaStreamTrack): Record<string, unknown> {
  let settings: MediaTrackSettings = {};
  try {
    settings = track.getSettings?.() ?? {};
  } catch {
    // Some WebKit versions can throw while a newly granted track settles.
  }
  return {
    readyState: track.readyState,
    enabled: track.enabled,
    muted: track.muted,
    settings: {
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount,
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    },
  };
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
  process(inputs, outputs) {
    // Never route the microphone to the speakers. Keeping an explicitly silent
    // output connected avoids Firefox treating a downstream zero-gain branch as
    // inactive while still letting the processor observe the input frames.
    const output = outputs[0];
    if (output) {
      for (const channel of output) channel.fill(0);
    }
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
  private captureLegacyNode: ScriptProcessorNode | null = null;
  private captureSink: GainNode | null = null;
  private workletUrl: string | null = null;
  private microphoneClaimed = false;
  private microphoneClaimPromise: Promise<{ granted: boolean; reason?: string }> | null = null;
  private startUtterancePromise: Promise<void> | null = null;

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
    private readonly voiceSessionId?: string,
  ) {}

  getState(): VoiceStreamState {
    return this.state;
  }

  isReadyForCapture(): boolean {
    return (this.state === 'ready' || this.state === 'recording')
      && this.dc?.readyState === 'open';
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
  async connect(opts: { acquireMic?: boolean; preparedMicrophone?: Promise<MediaStream> } = {}): Promise<boolean> {
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
      if (this.voiceSessionId) {
        const claim = await this.claimMicrophone();
        if (!claim.granted) {
          this.cb.onError(claim.reason || 'Microphone is active on another voice page.');
          return false;
        }
      }
      this.dbg('info', 'requesting mic (getUserMedia) before building the offer');
      try {
        this.mediaStream = await acquireVoiceMicrophone(opts.preparedMicrophone);
        const track = this.mediaStream.getAudioTracks()[0];
        this.dbg('info', 'mic granted', track ? microphoneTrackDebugData(track) : { audioTrack: 'missing' });
      } catch (error) {
        this.releaseMicrophone();
        this.dbg('result', 'unavailable: mic permission denied/unavailable', {
          errorName: error instanceof DOMException ? error.name : undefined,
          reason: error instanceof Error ? error.message : String(error),
        });
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
        if (!settled) {
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
        { sessionId: this.sessionId, voiceSessionId: this.voiceSessionId, sdp: offer.sdp ?? '' },
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

  /** Begin an utterance and send Web Audio PCM frames for ASR. */
  startUtterance(
    preparedContext?: AudioContext,
    preparedMicrophone?: Promise<MediaStream>,
  ): Promise<void> {
    if (this.startUtterancePromise) return this.startUtterancePromise;
    const starting = this.startUtteranceOnce(preparedContext, preparedMicrophone);
    this.startUtterancePromise = starting;
    void starting.then(
      () => { if (this.startUtterancePromise === starting) this.startUtterancePromise = null; },
      () => { if (this.startUtterancePromise === starting) this.startUtterancePromise = null; },
    );
    return starting;
  }

  private async startUtteranceOnce(
    preparedContext?: AudioContext,
    preparedMicrophone?: Promise<MediaStream>,
  ): Promise<void> {
    this.dbg('info', 'capture setup started', {
      sessionState: this.state,
      dataChannelState: this.dc?.readyState ?? 'missing',
      reusedMediaStream: !!this.mediaStream,
      preparedAudioContext: !!preparedContext,
      preparedMicrophone: !!preparedMicrophone,
    });
    if (!this.isReadyForCapture()) {
      this.dbg('error', 'capture rejected because session is stale', {
        sessionState: this.state,
        dataChannelState: this.dc?.readyState ?? 'missing',
      });
      throw new Error('Voice connection is no longer ready. Please try again.');
    }
    if (this.voiceSessionId) {
      const claim = await this.claimMicrophone();
      if (!claim.granted) {
        throw new Error(claim.reason || 'Microphone is active on another voice page.');
      }
    }
    // Reuse a stream already grabbed at connect() (the Safari ICE-gate path);
    // otherwise acquire it now (the prewarmed path that didn't need it up front).
    const stream = this.mediaStream ?? (await acquireVoiceMicrophone(preparedMicrophone));
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('Microphone audio track is unavailable.');
    if (track.readyState === 'ended') throw new Error('Microphone audio track ended before capture started.');
    this.dbg('info', 'microphone stream ready', microphoneTrackDebugData(track));

    let startSent = false;
    let firstFrameTimeout: ReturnType<typeof setTimeout> | null = null;
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
      this.dbg('info', 'capture AudioContext running', {
        state: ctx.state,
        sampleRate: ctx.sampleRate,
        baseLatency: ctx.baseLatency,
        outputLatency: ctx.outputLatency,
      });
      const source = ctx.createMediaStreamSource(stream);
      const sink = ctx.createGain();
      sink.gain.value = 1;
      sink.connect(ctx.destination);
      this.captureSource = source;
      this.captureSink = sink;
      this.mediaStream = stream;
      this.dbg('info', 'MediaStreamAudioSource and silent sink connected');

      const firstFrame = new Promise<void>((resolve, reject) => {
        let received = false;
        let frameCount = 0;
        const acceptFrame = (pcm: ArrayBuffer) => {
          frameCount++;
          // Keep a caller-owned copy before sending. DataChannel delivery is
          // reliable while open, but it is not a durable local buffer.
          this.cb.onAudioFrame?.(pcm.slice(0));
          if (this.dc?.readyState === 'open') this.dc.send(pcm);
          if (received) return;
          received = true;
          if (firstFrameTimeout) clearTimeout(firstFrameTimeout);
          firstFrameTimeout = null;
          this.dbg('result', 'first PCM frame received', {
            frameBytes: pcm.byteLength,
            frameCount,
            dataChannelState: this.dc?.readyState ?? 'missing',
            ...microphoneTrackDebugData(track),
          });
          resolve();
        };
        firstFrameTimeout = setTimeout(() => {
          if (received) return;
          received = true;
          this.dbg('error', 'first PCM frame timed out', {
            timeoutMs: CAPTURE_FIRST_FRAME_TIMEOUT_MS,
            frameCount,
            contextState: ctx.state,
            sampleRate: ctx.sampleRate,
            dataChannelState: this.dc?.readyState ?? 'missing',
            ...microphoneTrackDebugData(track),
          });
          reject(new Error(
            `Microphone started but produced no audio frames `
            + `(context=${ctx.state}, track=${track.readyState}, enabled=${track.enabled}, muted=${track.muted}, sampleRate=${ctx.sampleRate}).`,
          ));
        }, CAPTURE_FIRST_FRAME_TIMEOUT_MS);

        if (shouldUseLegacyPcmCapture(navigator.userAgent, navigator.maxTouchPoints)) {
          this.dbg('info', 'capture processor selected', {
            processor: 'ScriptProcessor',
            bufferSize: 2048,
            userAgent: navigator.userAgent,
            maxTouchPoints: navigator.maxTouchPoints,
          });
          // Firefox can leave the Worklet graph unpulled, while iOS WebKit can
          // expose a healthy live track without ever running the processor.
          // The legacy node exists only during capture and emits identical
          // 24 kHz PCM DataChannel frames.
          const legacy = ctx.createScriptProcessor(2048, 1, 1);
          legacy.onaudioprocess = (event) => {
            const output = event.outputBuffer.getChannelData(0);
            output.fill(0);
            const input = event.inputBuffer.getChannelData(0);
            if (input.length > 0) acceptFrame(downsampleFloatPcm(input, ctx.sampleRate));
          };
          source.connect(legacy);
          legacy.connect(sink);
          this.captureLegacyNode = legacy;
          return;
        }

        this.dbg('info', 'capture processor selected', {
          processor: 'AudioWorklet',
          userAgent: navigator.userAgent,
          maxTouchPoints: navigator.maxTouchPoints,
        });
        this.workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        void ctx.audioWorklet.addModule(this.workletUrl).then(() => {
          if (received) return;
          this.dbg('info', 'AudioWorklet module loaded');
          const node = new AudioWorkletNode(ctx, 'pcm-capture', {
            processorOptions: { targetRate: VOICE_PCM_SAMPLE_RATE },
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: 'explicit',
          });
          node.onprocessorerror = () => {
            if (received) return;
            received = true;
            if (firstFrameTimeout) clearTimeout(firstFrameTimeout);
            firstFrameTimeout = null;
            this.dbg('error', 'AudioWorklet processor error before first frame');
            reject(new Error('Microphone AudioWorklet processor failed.'));
          };
          node.port.onmessage = (event) => acceptFrame(event.data as ArrayBuffer);
          source.connect(node);
          node.connect(sink);
          this.captureNode = node;
        }).catch((error) => {
          if (received) return;
          received = true;
          if (firstFrameTimeout) clearTimeout(firstFrameTimeout);
          firstFrameTimeout = null;
          this.dbg('error', 'AudioWorklet module failed to load', {
            reason: error instanceof Error ? error.message : String(error),
          });
          reject(error);
        });
      });

      this.dcSend({
        t: 'start',
        config: this.config,
        sampleRate: VOICE_PCM_SAMPLE_RATE,
        audioTransport: 'datachannel',
      });
      startSent = true;
      this.dbg('info', 'ASR start message sent', { dataChannelState: this.dc?.readyState ?? 'missing' });
      await firstFrame;
    } catch (error) {
      if (firstFrameTimeout) clearTimeout(firstFrameTimeout);
      if (startSent) this.dcSend({ t: 'stop', releaseMicrophone: true });
      this.teardownCapture({ releaseMic: true });
      this.releaseMicrophone();
      const reason = error instanceof Error ? error.message : String(error);
      this.dbg('error', 'microphone capture failed to start', { reason });
      throw new Error(`Could not start microphone capture: ${reason}`);
    }
    this.setState('recording');
    this.dbg('result', 'microphone capture recording');
  }

  /** Re-send a locally retained PCM utterance through a fresh/live ASR
   * session. The ordered DataChannel preserves the original audio order. */
  replayUtterance(frames: ArrayBuffer[]): boolean {
    if (this.state !== 'ready' || this.dc?.readyState !== 'open' || frames.length === 0) return false;
    this.dcSend({
      t: 'start',
      config: this.config,
      sampleRate: VOICE_PCM_SAMPLE_RATE,
      audioTransport: 'datachannel',
    });
    for (const frame of frames) this.dc.send(frame);
    this.dcSend({ t: 'stop', releaseMicrophone: true });
    // A retry may have acquired the microphone solely to expose Safari host
    // ICE candidates. Replay itself has no local capture graph, so release it
    // immediately rather than leaving the browser mic indicator active.
    this.teardownCapture({ releaseMic: true });
    this.releaseMicrophone(false);
    return true;
  }

  /** End the current utterance: stop capture and ask the agent to finalize.
   *  Voice-agent continuous listening keeps the granted mic stream alive so the
   *  next utterance can start during assistant speech without a permission gap. */
  stopUtterance(opts: { releaseMic?: boolean; discard?: boolean } = {}): void {
    const releaseMic = opts.releaseMic ?? true;
    this.dbg('info', 'capture stop requested', {
      releaseMic,
      discard: !!opts.discard,
      sessionState: this.state,
      dataChannelState: this.dc?.readyState ?? 'missing',
    });
    this.dcSend({ t: 'stop', releaseMicrophone: releaseMic, discard: opts.discard });
    this.teardownCapture({ releaseMic });
    if (releaseMic) this.releaseMicrophone(false);
    if (this.state === 'recording') this.setState('ready');
  }

  /** Ask the agent to run ASR again over its retained copy of this utterance. */
  retryTranscription(): void {
    this.dcSend({ t: 'retry-transcription' });
  }

  /** Stop the agent's current outbound TTS after barge-in is confirmed. */
  interruptPlayback(): void {
    this.dcSend({ t: 'interrupt-playback' });
  }

  private dcSend(msg: VoiceDcMessage): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(msg));
  }

  private claimMicrophone(): Promise<{ granted: boolean; reason?: string }> {
    if (this.microphoneClaimed) return Promise.resolve({ granted: true });
    if (this.microphoneClaimPromise) return this.microphoneClaimPromise;
    const bus = getBusForAgent(this.agentId);
    if (!bus) return Promise.resolve({ granted: false, reason: 'Not connected to an agent.' });

    const claim = bus.command<VoiceRtcMicrophoneLeaseResponsePayload, VoiceRtcMicrophoneLeaseRequestPayload>(
      'voice:microphone-claim',
      { sessionId: this.sessionId, voiceSessionId: this.voiceSessionId ?? this.sessionId },
      { timeoutMs: MICROPHONE_CLAIM_TIMEOUT_MS },
    ).then((result) => {
      this.microphoneClaimed = result.ok;
      return { granted: result.ok, reason: result.error };
    }).catch(() => ({ granted: false, reason: 'Microphone ownership request failed.' }));
    this.microphoneClaimPromise = claim;
    void claim.finally(() => {
      if (this.microphoneClaimPromise === claim) this.microphoneClaimPromise = null;
    });
    return claim;
  }

  private releaseMicrophone(send = true): void {
    if (send && this.microphoneClaimed) this.dcSend({ t: 'microphone-release' });
    if (send && this.microphoneClaimed && this.voiceSessionId) {
      const bus = getBusForAgent(this.agentId);
      void bus?.command<VoiceRtcMicrophoneLeaseResponsePayload, VoiceRtcMicrophoneLeaseRequestPayload>(
        'voice:microphone-release',
        { sessionId: this.sessionId, voiceSessionId: this.voiceSessionId },
      ).catch(() => undefined);
    }
    this.microphoneClaimed = false;
  }

  private teardownCapture(opts: { releaseMic?: boolean } = {}): void {
    this.dbg('info', 'capture teardown', {
      releaseMic: opts.releaseMic !== false,
      contextState: this.audioCtx?.state ?? 'missing',
      hasStream: !!this.mediaStream,
      processor: this.captureLegacyNode ? 'ScriptProcessor' : this.captureNode ? 'AudioWorklet' : 'none',
    });
    if (this.captureNode) this.captureNode.port.onmessage = null;
    if (this.captureNode) this.captureNode.onprocessorerror = null;
    if (this.captureLegacyNode) this.captureLegacyNode.onaudioprocess = null;
    try {
      this.captureSource?.disconnect();
      this.captureNode?.disconnect();
      this.captureLegacyNode?.disconnect();
      this.captureSink?.disconnect();
    } catch {
      /* graph may already be disconnected */
    }
    this.captureSource = null;
    this.captureNode = null;
    this.captureLegacyNode = null;
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
    this.releaseMicrophone();
    this.microphoneClaimPromise = null;
    this.startUtterancePromise = null;
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
