// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Full-duplex streaming voice over WebRTC.
 *
 * The PWA establishes a P2P WebRTC connection to the agent (signaling rides the
 * bus; see `wireVoiceStream`). TTS uses the negotiated outbound audio track.
 * Microphone ASR currently retains the proven PCM/DataChannel path; RTP ingress
 * remains selectable for future browser validation. JSON control messages
 * carry utterance/VAD/transcript/playback state.
 *
 * `@roamhq/wrtc` is an optional native dependency and is loaded lazily: if it
 * is missing or fails to load, streaming is simply unavailable and the PWA
 * falls back to the batch `voice:transcribe` verb. No TURN is configured — if
 * the P2P connection cannot be established (STUN only), the PWA disables voice.
 */
import {
  VOICE_PCM_SAMPLE_RATE,
  type VoiceConfig,
  type VoiceDcMessage,
  type VoiceRtcConnectRequestPayload,
  type VoiceRtcConnectResponsePayload,
  type VoiceRtcIceRequestPayload,
  type VoiceRtcIceResponsePayload,
  type VoiceRtcIceUpdate,
  type VoiceRtcMicrophoneLeaseRequestPayload,
  type VoiceRtcMicrophoneLeaseResponsePayload,
} from '@sumicom/quicksave-shared';
import { randomUUID } from 'node:crypto';
import { RealtimeTranscriber } from './realtimeTranscription.js';
import { voiceEventLogger } from './voiceLog.js';
import {
  streamPcmSpeech,
  synthesizeSpeech,
  type SynthesizedSpeech,
} from './voiceIntermediary/tts.js';

/** Structural subset of MessageBusServer we depend on (keeps this testable). */
export interface VoiceBus {
  onCommand<Req = unknown, Res = unknown>(
    verb: string,
    handler: (payload: Req, ctx: { peer: string }) => Promise<Res> | Res,
  ): void;
  /** Register a subscribable push path. REQUIRED before `publish` to it can
   *  reach anyone — the server rejects subscriptions to unregistered patterns. */
  onSubscribe(pattern: string, handler: { snapshot: (ctx: unknown) => unknown }): void;
  publish<T>(path: string, data: T): void;
}

/** Classification of an inbound DataChannel message. */
export type VoiceDcInbound =
  | { kind: 'audio'; bytes: Buffer }
  | { kind: 'control'; msg: VoiceDcMessage }
  | { kind: 'ignore' };

/**
 * Decide whether a DataChannel frame is binary audio or a JSON control
 * message. Extracted (and pure) so it can be unit-tested without WebRTC.
 */
export function classifyVoiceDcData(data: unknown): VoiceDcInbound {
  if (typeof data === 'string') {
    try {
      const msg = JSON.parse(data) as VoiceDcMessage;
      if (msg && typeof (msg as { t?: unknown }).t === 'string') return { kind: 'control', msg };
    } catch {
      /* fall through */
    }
    return { kind: 'ignore' };
  }
  if (data instanceof ArrayBuffer) return { kind: 'audio', bytes: Buffer.from(data) };
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return { kind: 'audio', bytes: Buffer.from(view.buffer, view.byteOffset, view.byteLength) };
  }
  if (Buffer.isBuffer(data)) return { kind: 'audio', bytes: data };
  return { kind: 'ignore' };
}

/** Convert interleaved signed PCM16 to mono PCM16 at the ASR sample rate. */
export function resamplePcm16(
  samples: Int16Array,
  sourceRate: number,
  targetRate: number,
  channelCount = 1,
): Int16Array {
  if (samples.length === 0 || sourceRate <= 0 || targetRate <= 0 || channelCount <= 0) {
    return new Int16Array();
  }
  const sourceFrames = Math.floor(samples.length / channelCount);
  if (sourceFrames === 0) return new Int16Array();
  const targetFrames = Math.max(1, Math.round(sourceFrames * targetRate / sourceRate));
  const output = new Int16Array(targetFrames);
  for (let i = 0; i < targetFrames; i++) {
    const sourceFrame = Math.min(sourceFrames - 1, Math.floor(i * sourceRate / targetRate));
    let mixed = 0;
    for (let channel = 0; channel < channelCount; channel++) {
      mixed += samples[sourceFrame * channelCount + channel] ?? 0;
    }
    output[i] = Math.round(mixed / channelCount);
  }
  return output;
}

/** True only when the offer can receive/send a WebRTC audio media track. */
export function offerNegotiatesAudio(sdp: string): boolean {
  return /^m=audio\s/m.test(sdp);
}

/**
 * Probe this machine's voice capability for the handshake ack. Batch
 * transcription is always available in this build; streaming additionally
 * requires the optional native WebRTC dependency to load.
 */
export async function probeAudioSupport(): Promise<{ transcription: boolean; streaming: boolean }> {
  return { transcription: true, streaming: (await loadWrtc()) !== null };
}

/** STUN servers from env (comma-separated) or a public default. No TURN. */
export function iceServers(): { urls: string }[] {
  const env = process.env.QUICKSAVE_VOICE_STUN?.trim();
  const urls = env ? env.split(',').map((s) => s.trim()).filter(Boolean) : ['stun:stun.l.google.com:19302'];
  return urls.map((u) => ({ urls: u }));
}

interface RtcAudioData {
  samples: Int16Array;
  sampleRate: number;
  bitsPerSample?: number;
  channelCount?: number;
  numberOfFrames?: number;
}
interface RtcAudioSinkLike {
  ondata: ((data: RtcAudioData) => void) | null;
  stop(): void;
}
interface RtcMediaStreamTrackLike {
  kind: string;
  stop(): void;
}
interface RtcAudioSourceLike {
  createTrack(): RtcMediaStreamTrackLike;
  onData(data: RtcAudioData): void;
}

// Lazy, cached optional load of the native WebRTC implementation.
export type WrtcModule = {
  RTCPeerConnection: new (cfg: unknown) => RTCPeerConnectionLike;
  nonstandard: {
    RTCAudioSink: new (track: RtcMediaStreamTrackLike) => RtcAudioSinkLike;
    RTCAudioSource: new () => RtcAudioSourceLike;
  };
};
let wrtcCache: WrtcModule | null | undefined;
export async function loadWrtc(): Promise<WrtcModule | null> {
  if (wrtcCache !== undefined) return wrtcCache;
  try {
    const mod = (await import('@roamhq/wrtc')) as unknown as { default?: WrtcModule } & WrtcModule;
    wrtcCache = (mod.default ?? mod) as WrtcModule;
  } catch {
    wrtcCache = null;
  }
  return wrtcCache;
}

/** Minimal WebRTC surface we use (subset of the standard API). */
export interface RTCPeerConnectionLike {
  onicecandidate: ((e: { candidate: unknown | null }) => void) | null;
  ondatachannel: ((e: { channel: RTCDataChannelLike }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((e: { track: RtcMediaStreamTrackLike }) => void) | null;
  connectionState: string;
  setRemoteDescription(desc: { type: string; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(desc: { type: string; sdp?: string }): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  addTrack(track: RtcMediaStreamTrackLike): unknown;
  close(): void;
}
export interface RTCDataChannelLike {
  onmessage: ((e: { data: unknown }) => void) | null;
  onopen?: (() => void) | null;
  onclose: (() => void) | null;
  onerror?: (() => void) | null;
  onbufferedamountlow?: (() => void) | null;
  bufferedAmount?: number;
  bufferedAmountLowThreshold?: number;
  readyState?: string;
  send(data: string | Buffer | Uint8Array | ArrayBuffer): void;
  close?(): void;
}

interface VoicePeer {
  transportId: string;
  voiceSessionId: string;
  requiresMicrophoneLease: boolean;
  pc: RTCPeerConnectionLike;
  transcriber: RealtimeTranscriber | null;
  captureActive: boolean;
  audioTransport: 'datachannel' | 'media-track';
  audioSink: RtcAudioSinkLike | null;
  audioSource: RtcAudioSourceLike;
  sourceTrack: RtcMediaStreamTrackLike;
  mediaTrackNegotiated: boolean;
  sendDc: ((msg: VoiceDcMessage) => void) | null;
  retryConfig: VoiceConfig | null;
  retrySampleRate: number;
  retryAudio: Buffer[];
  retryAudioBytes: number;
  retryAudioAvailable: boolean;
}

const MAX_RETRY_AUDIO_BYTES = 5 * 1024 * 1024;

export class MicrophoneLeaseRegistry {
  private readonly owners = new Map<string, string>();

  claim(sessionId: string, transportId: string): boolean {
    const owner = this.owners.get(sessionId);
    if (owner && owner !== transportId) return false;
    this.owners.set(sessionId, transportId);
    return true;
  }

  owns(sessionId: string, transportId: string): boolean {
    return this.owners.get(sessionId) === transportId;
  }

  release(sessionId: string, transportId: string): boolean {
    if (!this.owns(sessionId, transportId)) return false;
    this.owners.delete(sessionId);
    return true;
  }
}

export function canStartVoiceCapture(requiresLease: boolean, ownsLease: boolean): boolean {
  return !requiresLease || ownsLease;
}

/**
 * Manages per-session WebRTC peers and their ASR bridges. One instance is
 * created per agent process; `wireVoiceStream` registers the bus handlers.
 */
export class VoiceStreamManager {
  private readonly peers = new Map<string, VoicePeer>();
  private readonly sessionPeers = new Map<string, Set<string>>();
  private readonly microphoneLeases = new MicrophoneLeaseRegistry();
  private readonly outbounds = new Map<string, { streamId: string; controller: AbortController }>();

  constructor(private readonly bus: VoiceBus) {}

  /** Whether streaming is available (native WebRTC loadable) on this host. */
  async available(): Promise<boolean> {
    return (await loadWrtc()) !== null;
  }

  /** Handle a WebRTC offer; returns the SDP answer (or an error). */
  async connect(transportId: string, voiceSessionId: string | undefined, offerSdp: string): Promise<VoiceRtcConnectResponsePayload> {
    const wrtc = await loadWrtc();
    if (!wrtc) return { error: 'Streaming voice is unavailable on this agent.' };

    this.teardown(transportId); // replace only this page's stale transport

    const pc = new wrtc.RTCPeerConnection({ iceServers: iceServers() });
    const audioSource = new wrtc.nonstandard.RTCAudioSource();
    const sourceTrack = audioSource.createTrack();
    const peer: VoicePeer = {
      transportId,
      voiceSessionId: voiceSessionId ?? transportId,
      requiresMicrophoneLease: voiceSessionId !== undefined,
      pc,
      transcriber: null,
      captureActive: false,
      audioTransport: 'datachannel',
      audioSink: null,
      audioSource,
      sourceTrack,
      mediaTrackNegotiated: false,
      sendDc: null,
      retryConfig: null,
      retrySampleRate: VOICE_PCM_SAMPLE_RATE,
      retryAudio: [],
      retryAudioBytes: 0,
      retryAudioAvailable: true,
    };
    this.peers.set(transportId, peer);
    const resolvedVoiceSessionId = peer.voiceSessionId;
    const transports = this.sessionPeers.get(resolvedVoiceSessionId) ?? new Set<string>();
    transports.add(transportId);
    this.sessionPeers.set(resolvedVoiceSessionId, transports);

    pc.onicecandidate = (e) => {
      const candidate = e.candidate ? JSON.stringify(e.candidate) : null;
      this.bus.publish<VoiceRtcIceUpdate>(`/voice/rtc/${transportId}`, { candidate });
    };
    pc.ondatachannel = (e) => this.wireDataChannel(peer, e.channel);
    pc.ontrack = (e) => this.attachInboundAudio(peer, wrtc, e.track);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.teardown(transportId);
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      peer.mediaTrackNegotiated = offerNegotiatesAudio(offerSdp);
      if (peer.mediaTrackNegotiated) pc.addTrack(sourceTrack);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      return { sdp: answer.sdp };
    } catch (err) {
      this.teardown(transportId);
      return { error: err instanceof Error ? err.message : 'Failed to negotiate WebRTC connection.' };
    }
  }

  /** Add a trickled ICE candidate from the PWA. */
  async addIce(sessionId: string, candidate: string | null): Promise<VoiceRtcIceResponsePayload> {
    const peer = this.peers.get(sessionId);
    if (!peer) return { ok: false, error: 'No active voice session.' };
    if (candidate === null) return { ok: true }; // end-of-candidates marker
    try {
      await peer.pc.addIceCandidate(JSON.parse(candidate));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Bad ICE candidate.' };
    }
  }

  claimMicrophone(transportId: string, voiceSessionId: string): VoiceRtcMicrophoneLeaseResponsePayload {
    const ok = this.microphoneLeases.claim(voiceSessionId, transportId);
    return { ok, error: ok ? undefined : 'Microphone is active on another voice page.' };
  }

  releaseMicrophoneLease(transportId: string, voiceSessionId: string): VoiceRtcMicrophoneLeaseResponsePayload {
    this.microphoneLeases.release(voiceSessionId, transportId);
    return { ok: true };
  }

  private wireDataChannel(peer: VoicePeer, channel: RTCDataChannelLike): void {
    const sendDc = (msg: VoiceDcMessage) => {
      try {
        channel.send(JSON.stringify(msg));
      } catch {
        /* channel may have closed */
      }
    };
    peer.sendDc = sendDc;

    channel.onmessage = (e) => {
      const inbound = classifyVoiceDcData(e.data);
      if (inbound.kind === 'audio') {
        if (peer.captureActive && peer.audioTransport === 'datachannel') {
          this.appendCapturedAudio(peer, inbound.bytes);
        }
        return;
      }
      if (inbound.kind !== 'control') return;
      const msg = inbound.msg;
      if (msg.t === 'microphone-claim') {
        const granted = this.microphoneLeases.claim(peer.voiceSessionId, peer.transportId);
        sendDc({
          t: 'microphone-claim-result',
          granted,
          reason: granted ? undefined : 'Microphone is active on another voice page.',
        });
      } else if (msg.t === 'microphone-release') {
        this.releaseMicrophone(peer);
      } else if (msg.t === 'start') {
        if (!canStartVoiceCapture(
          peer.requiresMicrophoneLease,
          this.microphoneLeases.owns(peer.voiceSessionId, peer.transportId),
        )) {
          sendDc({ t: 'error', message: 'Microphone ownership is required before recording.' });
          return;
        }
        peer.retryConfig = msg.config;
        peer.retrySampleRate = msg.sampleRate;
        peer.retryAudio = [];
        peer.retryAudioBytes = 0;
        peer.retryAudioAvailable = true;
        this.startUtterance(
          peer,
          msg.config,
          msg.sampleRate,
          msg.audioTransport ?? 'datachannel',
          sendDc,
        );
      } else if (msg.t === 'stop') {
        peer.captureActive = false;
        if (msg.discard) {
          peer.transcriber?.close();
          peer.transcriber = null;
          this.clearRetryAudio(peer);
        } else {
          peer.transcriber?.commit();
        }
        if (msg.releaseMicrophone) this.releaseMicrophone(peer);
      } else if (msg.t === 'retry-transcription') {
        if (!peer.retryConfig || !peer.retryAudioAvailable || peer.retryAudio.length === 0) {
          sendDc({ t: 'error', message: 'The recorded audio is no longer available to retry.' });
          return;
        }
        const retained = peer.retryAudio;
        this.startUtterance(
          peer,
          peer.retryConfig,
          peer.retrySampleRate,
          peer.audioTransport,
          sendDc,
        );
        peer.captureActive = false;
        for (const chunk of retained) peer.transcriber?.appendAudio(chunk);
        peer.transcriber?.commit();
      } else if (msg.t === 'interrupt-playback') {
        if (!peer.requiresMicrophoneLease
          || this.microphoneLeases.owns(peer.voiceSessionId, peer.transportId)) {
          this.cancelOutbound(peer.voiceSessionId);
        }
      }
    };
    channel.onclose = () => this.teardown(peer.transportId);
  }

  private startUtterance(
    peer: VoicePeer,
    config: VoiceConfig,
    _sampleRate: number,
    audioTransport: 'datachannel' | 'media-track',
    sendDc: (msg: VoiceDcMessage) => void,
  ): void {
    peer.transcriber?.close();
    peer.captureActive = true;
    peer.audioTransport = audioTransport;
    peer.transcriber = new RealtimeTranscriber(config, VOICE_PCM_SAMPLE_RATE, {
      onSpeechStarted: () => {
        voiceEventLogger.log({ sessionId: peer.voiceSessionId, event: 'vad.speech_started', phase: 'vad' });
        sendDc({ t: 'speech', active: true });
      },
      onSpeechStopped: () => {
        voiceEventLogger.log({ sessionId: peer.voiceSessionId, event: 'vad.speech_stopped', phase: 'vad' });
        sendDc({ t: 'speech', active: false });
      },
      onPartial: (text) => {
        voiceEventLogger.log({ sessionId: peer.voiceSessionId, event: 'asr.partial', phase: 'asr', data: { textChars: text.length } });
        sendDc({ t: 'transcript', final: false, text });
      },
      onFinal: (text) => {
        voiceEventLogger.log({ sessionId: peer.voiceSessionId, event: 'asr.final_fragment', phase: 'asr', data: { text, textChars: text.length } });
        sendDc({ t: 'transcript', final: true, text });
      },
      onError: (message) => {
        voiceEventLogger.log({ sessionId: peer.voiceSessionId, event: 'asr.error', phase: 'asr', level: 'error', data: { message } });
        sendDc({ t: 'error', message });
      },
    });
    peer.transcriber.start();
  }

  private appendCapturedAudio(peer: VoicePeer, bytes: Buffer | Uint8Array): void {
    const chunk = Buffer.from(bytes);
    if (peer.retryAudioAvailable) {
      if (peer.retryAudioBytes + chunk.byteLength <= MAX_RETRY_AUDIO_BYTES) {
        peer.retryAudio.push(Buffer.from(chunk));
        peer.retryAudioBytes += chunk.byteLength;
      } else {
        peer.retryAudio = [];
        peer.retryAudioBytes = 0;
        peer.retryAudioAvailable = false;
      }
    }
    peer.transcriber?.appendAudio(chunk);
  }

  private clearRetryAudio(peer: VoicePeer): void {
    peer.retryConfig = null;
    peer.retryAudio = [];
    peer.retryAudioBytes = 0;
    peer.retryAudioAvailable = true;
  }

  private attachInboundAudio(
    peer: VoicePeer,
    wrtc: WrtcModule,
    track: RtcMediaStreamTrackLike,
  ): void {
    if (track.kind !== 'audio') return;
    peer.audioSink?.stop();
    const sink = new wrtc.nonstandard.RTCAudioSink(track);
    peer.audioSink = sink;
    sink.ondata = (data) => {
      if (!peer.captureActive || peer.audioTransport !== 'media-track' || !peer.transcriber) return;
      const pcm = resamplePcm16(
        data.samples,
        data.sampleRate,
        VOICE_PCM_SAMPLE_RATE,
        data.channelCount ?? 1,
      );
      if (pcm.length > 0) {
        this.appendCapturedAudio(peer, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      }
    };
    voiceEventLogger.log({
      sessionId: peer.voiceSessionId,
      event: 'webrtc.audio_track.attached',
      phase: 'transport',
      data: { kind: track.kind },
    });
  }

  /**
   * Deliver TTS over the negotiated outbound audio track when possible. Peers
   * without an offered audio m-line retain the fetchable MP3 path.
   */
  async synthesizeSpeech(sessionId: string, config: VoiceConfig, text: string): Promise<SynthesizedSpeech | null> {
    if (this.playbackPeers(sessionId).length === 0) {
      return synthesizeSpeech(config, text);
    }

    this.cancelOutbound(sessionId);
    const streamId = randomUUID();
    const controller = new AbortController();
    this.outbounds.set(sessionId, { streamId, controller });
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let playbackStarted = false;
    let nextFrameAt = Date.now();

    const emitFrame = async (bytes: Buffer): Promise<void> => {
      if (controller.signal.aborted) return;
      if (!playbackStarted) {
        playbackStarted = true;
        nextFrameAt = Date.now();
        this.broadcastPlayback(sessionId, { t: 'playback', active: true, streamId });
      }
      const waitMs = nextFrameAt - Date.now();
      if (waitMs > 0) await delay(waitMs);
      if (controller.signal.aborted) return;
      const samples = new Int16Array(VOICE_PCM_SAMPLE_RATE / 100);
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
      for (const peer of this.playbackPeers(sessionId)) {
        peer.audioSource.onData({
          samples,
          sampleRate: VOICE_PCM_SAMPLE_RATE,
          bitsPerSample: 16,
          channelCount: 1,
          numberOfFrames: samples.length,
        });
      }
      nextFrameAt += 10;
    };

    try {
      const speech = await streamPcmSpeech(config, text, async (chunk) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        const frameBytes = VOICE_PCM_SAMPLE_RATE / 100 * 2;
        while (pending.length >= frameBytes && !controller.signal.aborted) {
          const frame = pending.subarray(0, frameBytes);
          pending = pending.subarray(frameBytes);
          await emitFrame(frame);
        }
      }, { signal: controller.signal });

      if (controller.signal.aborted) {
        return { audio: Buffer.alloc(0), mimeType: 'audio/wav', streamed: true, interrupted: true };
      }
      if (pending.length > 0) {
        const frameBytes = VOICE_PCM_SAMPLE_RATE / 100 * 2;
        const padded = Buffer.alloc(frameBytes);
        pending.copy(padded);
        await emitFrame(padded);
      }
      if (!speech) return null;
      return speech;
    } catch (error) {
      if (controller.signal.aborted) {
        return { audio: Buffer.alloc(0), mimeType: 'audio/wav', streamed: true, interrupted: true };
      }
      // Providers that do not support raw PCM keep the established MP3 path.
      if (!playbackStarted) return synthesizeSpeech(config, text);
      throw error;
    } finally {
      const stillCurrent = this.outbounds.get(sessionId)?.streamId === streamId;
      if (stillCurrent) this.outbounds.delete(sessionId);
      if (playbackStarted && stillCurrent) {
        this.broadcastPlayback(sessionId, { t: 'playback', active: false, streamId });
      }
    }
  }

  private playbackPeers(sessionId: string): VoicePeer[] {
    const ids = this.sessionPeers.get(sessionId);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.peers.get(id))
      .filter((peer): peer is VoicePeer => !!peer
        && !!peer.sendDc
        && peer.mediaTrackNegotiated
        && peer.pc.connectionState === 'connected');
  }

  private broadcastPlayback(sessionId: string, message: VoiceDcMessage): void {
    for (const peer of this.playbackPeers(sessionId)) peer.sendDc?.(message);
  }

  private cancelOutbound(sessionId: string): void {
    const outbound = this.outbounds.get(sessionId);
    if (!outbound) return;
    this.outbounds.delete(sessionId);
    outbound.controller.abort();
    this.broadcastPlayback(sessionId, { t: 'playback', active: false, streamId: outbound.streamId });
  }

  private releaseMicrophone(peer: VoicePeer): void {
    if (!this.microphoneLeases.release(peer.voiceSessionId, peer.transportId)) return;
    peer.captureActive = false;
  }

  private teardown(transportId: string): void {
    const peer = this.peers.get(transportId);
    if (!peer) return;
    this.peers.delete(transportId);
    this.releaseMicrophone(peer);
    const transports = this.sessionPeers.get(peer.voiceSessionId);
    transports?.delete(transportId);
    if (transports?.size === 0) {
      this.sessionPeers.delete(peer.voiceSessionId);
      this.cancelOutbound(peer.voiceSessionId);
    }
    peer.captureActive = false;
    peer.transcriber?.close();
    this.clearRetryAudio(peer);
    peer.audioSink?.stop();
    peer.sourceTrack.stop();
    try {
      peer.pc.close();
    } catch {
      /* already closed */
    }
  }

  /** Close all peers (process shutdown). */
  closeAll(): void {
    for (const id of [...this.peers.keys()]) this.teardown(id);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * Register the streaming-voice signaling verbs on the bus. Kept separate from
 * `wireLegacyBusVerbs` because these need async ICE pushes via `bus.publish`,
 * which the MessageHandler dispatch path does not expose.
 */
export function wireVoiceStream(bus: VoiceBus): VoiceStreamManager {
  const manager = new VoiceStreamManager(bus);

  // The agent trickles its ICE candidates to the PWA on this path. It MUST be
  // registered like any subscribable path — otherwise the server rejects the
  // PWA's `sub` with `sub-error` and `publish()` reaches zero peers, so the
  // agent's candidates never arrive and P2P always times out (remote
  // candidates = 0). Push-only, so the snapshot is null.
  bus.onSubscribe('/voice/rtc/:sessionId', { snapshot: () => null });

  bus.onCommand<VoiceRtcConnectRequestPayload, VoiceRtcConnectResponsePayload>(
    'voice:rtc-connect',
    (payload) => manager.connect(payload.sessionId, payload.voiceSessionId, payload.sdp),
  );
  bus.onCommand<VoiceRtcIceRequestPayload, VoiceRtcIceResponsePayload>(
    'voice:rtc-ice',
    (payload) => manager.addIce(payload.sessionId, payload.candidate),
  );
  bus.onCommand<VoiceRtcMicrophoneLeaseRequestPayload, VoiceRtcMicrophoneLeaseResponsePayload>(
    'voice:microphone-claim',
    (payload) => manager.claimMicrophone(payload.sessionId, payload.voiceSessionId),
  );
  bus.onCommand<VoiceRtcMicrophoneLeaseRequestPayload, VoiceRtcMicrophoneLeaseResponsePayload>(
    'voice:microphone-release',
    (payload) => manager.releaseMicrophoneLease(payload.sessionId, payload.voiceSessionId),
  );

  return manager;
}
