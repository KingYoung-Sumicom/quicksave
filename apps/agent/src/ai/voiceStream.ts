// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Streaming voice over WebRTC (Phase 1: STT input).
 *
 * The PWA establishes a P2P WebRTC connection to the agent (signaling rides the
 * bus; see `wireVoiceStream`). Audio rides a DataChannel as raw PCM16 binary
 * frames; small JSON control messages (`VoiceDcMessage`) start/stop an
 * utterance. The agent bridges each utterance to a streaming, OpenAI-Realtime-
 * compatible ASR (`RealtimeTranscriber`) and pushes partial/final transcripts
 * back over the same DataChannel.
 *
 * `@roamhq/wrtc` is an optional native dependency and is loaded lazily: if it
 * is missing or fails to load, streaming is simply unavailable and the PWA
 * falls back to the batch `voice:transcribe` verb. No TURN is configured — if
 * the P2P connection cannot be established (STUN only), the PWA disables voice.
 */
import type {
  VoiceConfig,
  VoiceDcMessage,
  VoiceRtcConnectRequestPayload,
  VoiceRtcConnectResponsePayload,
  VoiceRtcIceRequestPayload,
  VoiceRtcIceResponsePayload,
  VoiceRtcIceUpdate,
} from '@sumicom/quicksave-shared';
import { RealtimeTranscriber } from './realtimeTranscription.js';
import { voiceEventLogger } from './voiceLog.js';

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

/**
 * Probe this machine's voice capability for the handshake ack. Batch
 * transcription is always available in this build; streaming additionally
 * requires the optional native WebRTC dependency to load.
 */
export async function probeAudioSupport(): Promise<{ transcription: boolean; streaming: boolean }> {
  return { transcription: true, streaming: (await loadWrtc()) !== null };
}

/** STUN servers from env (comma-separated) or a public default. No TURN. */
function iceServers(): { urls: string }[] {
  const env = process.env.QUICKSAVE_VOICE_STUN?.trim();
  const urls = env ? env.split(',').map((s) => s.trim()).filter(Boolean) : ['stun:stun.l.google.com:19302'];
  return urls.map((u) => ({ urls: u }));
}

// Lazy, cached optional load of the native WebRTC implementation.
type WrtcModule = { RTCPeerConnection: new (cfg: unknown) => RTCPeerConnectionLike };
let wrtcCache: WrtcModule | null | undefined;
async function loadWrtc(): Promise<WrtcModule | null> {
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
interface RTCPeerConnectionLike {
  onicecandidate: ((e: { candidate: unknown | null }) => void) | null;
  ondatachannel: ((e: { channel: RTCDataChannelLike }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  connectionState: string;
  setRemoteDescription(desc: { type: string; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(desc: { type: string; sdp?: string }): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  close(): void;
}
interface RTCDataChannelLike {
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
}

interface VoicePeer {
  pc: RTCPeerConnectionLike;
  transcriber: RealtimeTranscriber | null;
}

/**
 * Manages per-session WebRTC peers and their ASR bridges. One instance is
 * created per agent process; `wireVoiceStream` registers the bus handlers.
 */
export class VoiceStreamManager {
  private readonly peers = new Map<string, VoicePeer>();

  constructor(private readonly bus: VoiceBus) {}

  /** Whether streaming is available (native WebRTC loadable) on this host. */
  async available(): Promise<boolean> {
    return (await loadWrtc()) !== null;
  }

  /** Handle a WebRTC offer; returns the SDP answer (or an error). */
  async connect(sessionId: string, offerSdp: string): Promise<VoiceRtcConnectResponsePayload> {
    const wrtc = await loadWrtc();
    if (!wrtc) return { error: 'Streaming voice is unavailable on this agent.' };

    this.teardown(sessionId); // replace any stale peer for this session

    const pc = new wrtc.RTCPeerConnection({ iceServers: iceServers() });
    const peer: VoicePeer = { pc, transcriber: null };
    this.peers.set(sessionId, peer);

    pc.onicecandidate = (e) => {
      const candidate = e.candidate ? JSON.stringify(e.candidate) : null;
      this.bus.publish<VoiceRtcIceUpdate>(`/voice/rtc/${sessionId}`, { candidate });
    };
    pc.ondatachannel = (e) => this.wireDataChannel(sessionId, peer, e.channel);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.teardown(sessionId);
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      return { sdp: answer.sdp };
    } catch (err) {
      this.teardown(sessionId);
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

  private wireDataChannel(sessionId: string, peer: VoicePeer, channel: RTCDataChannelLike): void {
    const sendDc = (msg: VoiceDcMessage) => {
      try {
        channel.send(JSON.stringify(msg));
      } catch {
        /* channel may have closed */
      }
    };

    channel.onmessage = (e) => {
      const inbound = classifyVoiceDcData(e.data);
      if (inbound.kind === 'audio') {
        peer.transcriber?.appendAudio(inbound.bytes);
        return;
      }
      if (inbound.kind !== 'control') return;
      const msg = inbound.msg;
      if (msg.t === 'start') {
        this.startUtterance(sessionId, peer, msg.config, msg.sampleRate, sendDc);
      } else if (msg.t === 'stop') {
        peer.transcriber?.commit();
      }
    };
    channel.onclose = () => this.teardown(sessionId);
  }

  private startUtterance(
    sessionId: string,
    peer: VoicePeer,
    config: VoiceConfig,
    sampleRate: number,
    sendDc: (msg: VoiceDcMessage) => void,
  ): void {
    peer.transcriber?.close();
    peer.transcriber = new RealtimeTranscriber(config, sampleRate, {
      onSpeechStarted: () => {
        voiceEventLogger.log({ sessionId, event: 'vad.speech_started', phase: 'vad' });
        sendDc({ t: 'speech', active: true });
      },
      onSpeechStopped: () => {
        voiceEventLogger.log({ sessionId, event: 'vad.speech_stopped', phase: 'vad' });
        sendDc({ t: 'speech', active: false });
      },
      onPartial: (text) => {
        voiceEventLogger.log({ sessionId, event: 'asr.partial', phase: 'asr', data: { textChars: text.length } });
        sendDc({ t: 'transcript', final: false, text });
      },
      onFinal: (text) => {
        voiceEventLogger.log({ sessionId, event: 'asr.final_fragment', phase: 'asr', data: { text, textChars: text.length } });
        sendDc({ t: 'transcript', final: true, text });
      },
      onError: (message) => {
        voiceEventLogger.log({ sessionId, event: 'asr.error', phase: 'asr', level: 'error', data: { message } });
        sendDc({ t: 'error', message });
      },
    });
    peer.transcriber.start();
  }

  private teardown(sessionId: string): void {
    const peer = this.peers.get(sessionId);
    if (!peer) return;
    this.peers.delete(sessionId);
    peer.transcriber?.close();
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
    (payload) => manager.connect(payload.sessionId, payload.sdp),
  );
  bus.onCommand<VoiceRtcIceRequestPayload, VoiceRtcIceResponsePayload>(
    'voice:rtc-ice',
    (payload) => manager.addIce(payload.sessionId, payload.candidate),
  );

  return manager;
}
