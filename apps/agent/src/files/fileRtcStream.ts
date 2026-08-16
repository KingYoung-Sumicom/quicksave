// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/** Direct large-file preview transport. Signaling uses the authenticated bus;
 * raw bytes use an ordered/reliable WebRTC DataChannel. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type {
  FileReadKind,
  FilesRtcCancelResponsePayload,
  FilesRtcConnectRequestPayload,
  FilesRtcConnectResponsePayload,
  FilesRtcDataMessage,
  FilesRtcIceRequestPayload,
  FilesRtcIceResponsePayload,
  FilesRtcIceUpdate,
} from '@sumicom/quicksave-shared';
import {
  iceServers,
  loadWrtc,
  type RTCDataChannelLike,
  type RTCPeerConnectionLike,
} from '../ai/voiceStream.js';

export const FILE_RTC_MAX_BYTES = 64 * 1024 * 1024;
const FILE_RTC_CHUNK_BYTES = 64 * 1024;
const FILE_RTC_BUFFER_HIGH_WATER = 4 * 1024 * 1024;
const FILE_RTC_IDLE_MS = 60_000;
const MAX_TRANSFERS_PER_PEER = 2;
const SNIFF_BYTES = 8 * 1024;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
};

export interface FileRtcBus {
  onCommand<Req = unknown, Res = unknown>(
    verb: string,
    handler: (payload: Req, ctx: { peer: string }) => Promise<Res> | Res,
  ): void;
  onSubscribe(pattern: string, handler: { snapshot: (ctx: unknown) => unknown }): void;
  publish<T>(path: string, data: T): void;
}

interface PreparedFile {
  cwd: string;
  path: string;
  absolutePath: string;
  size: number;
  mtime: number;
  kind: FileReadKind;
  mimeType?: string;
}

interface FilePeer {
  transferId: string;
  ownerPeer: string;
  pc: RTCPeerConnectionLike;
  file: PreparedFile;
  timer: ReturnType<typeof setTimeout>;
  channel: RTCDataChannelLike | null;
  streaming: boolean;
}

export class FileRtcStreamManager {
  private readonly peers = new Map<string, FilePeer>();

  constructor(private readonly bus: FileRtcBus) {}

  async connect(
    payload: FilesRtcConnectRequestPayload,
    ownerPeer: string,
  ): Promise<FilesRtcConnectResponsePayload> {
    if (!payload.transferId || this.peers.has(payload.transferId)) {
      return { error: 'Invalid or duplicate file transfer id.' };
    }
    const activeForPeer = [...this.peers.values()].filter((p) => p.ownerPeer === ownerPeer).length;
    if (activeForPeer >= MAX_TRANSFERS_PER_PEER) {
      return { error: 'Too many concurrent file transfers.' };
    }

    let file: PreparedFile;
    try {
      file = await prepareFile(payload);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }

    const wrtc = await loadWrtc();
    if (!wrtc) return { error: 'WebRTC file transfer is unavailable on this agent.' };
    const pc = new wrtc.RTCPeerConnection({ iceServers: iceServers() });
    const peer: FilePeer = {
      transferId: payload.transferId,
      ownerPeer,
      pc,
      file,
      timer: setTimeout(() => this.teardown(payload.transferId), FILE_RTC_IDLE_MS),
      channel: null,
      streaming: false,
    };
    this.peers.set(payload.transferId, peer);

    pc.onicecandidate = (event) => {
      const candidate = event.candidate ? JSON.stringify(event.candidate) : null;
      this.bus.publish<FilesRtcIceUpdate>(`/files/rtc/${payload.transferId}`, { candidate });
    };
    pc.ondatachannel = (event) => this.wireChannel(peer, event.channel);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this.teardown(payload.transferId);
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      return { sdp: answer.sdp };
    } catch (error) {
      this.teardown(payload.transferId);
      return { error: error instanceof Error ? error.message : 'Failed to negotiate file transfer.' };
    }
  }

  async addIce(
    payload: FilesRtcIceRequestPayload,
    ownerPeer: string,
  ): Promise<FilesRtcIceResponsePayload> {
    const peer = this.peers.get(payload.transferId);
    if (!peer || peer.ownerPeer !== ownerPeer) return { ok: false, error: 'No active file transfer.' };
    if (payload.candidate === null) return { ok: true };
    try {
      await peer.pc.addIceCandidate(JSON.parse(payload.candidate));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Bad ICE candidate.' };
    }
  }

  cancel(transferId: string, ownerPeer: string): FilesRtcCancelResponsePayload {
    const peer = this.peers.get(transferId);
    if (!peer || peer.ownerPeer !== ownerPeer) return { ok: true };
    this.teardown(transferId);
    return { ok: true };
  }

  private wireChannel(peer: FilePeer, channel: RTCDataChannelLike): void {
    peer.channel = channel;
    channel.onclose = () => this.teardown(peer.transferId);
    channel.onerror = () => this.teardown(peer.transferId);
    channel.onopen = () => void this.streamFile(peer);
    if (channel.readyState === 'open') void this.streamFile(peer);
  }

  private async streamFile(peer: FilePeer): Promise<void> {
    if (peer.streaming || !peer.channel) return;
    peer.streaming = true;
    clearTimeout(peer.timer);
    const channel = peer.channel;
    const header: FilesRtcDataMessage = { t: 'header', ...peer.file };
    try {
      channel.send(JSON.stringify(header));
      if (peer.file.kind === 'binary') {
        channel.send(JSON.stringify({ t: 'complete', bytes: 0 } satisfies FilesRtcDataMessage));
        return;
      }

      const hash = createHash('sha256');
      let sent = 0;
      for await (const chunk of createReadStream(peer.file.absolutePath, { highWaterMark: FILE_RTC_CHUNK_BYTES })) {
        if (channel.readyState === 'closed') throw new Error('File transfer was cancelled.');
        await waitForWritable(channel);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        channel.send(bytes);
        hash.update(bytes);
        sent += bytes.byteLength;
      }
      const current = await stat(peer.file.absolutePath);
      if (current.size !== peer.file.size || Math.floor(current.mtimeMs) !== peer.file.mtime || sent !== peer.file.size) {
        throw new Error('File changed while it was being transferred.');
      }
      channel.send(JSON.stringify({
        t: 'complete',
        bytes: sent,
        sha256: hash.digest('hex'),
      } satisfies FilesRtcDataMessage));
    } catch (error) {
      try {
        channel.send(JSON.stringify({
          t: 'error',
          message: error instanceof Error ? error.message : String(error),
        } satisfies FilesRtcDataMessage));
      } catch { /* channel already closed */ }
      this.teardown(peer.transferId);
    }
  }

  private teardown(transferId: string): void {
    const peer = this.peers.get(transferId);
    if (!peer) return;
    this.peers.delete(transferId);
    clearTimeout(peer.timer);
    try { peer.channel?.close?.(); } catch { /* already closed */ }
    try { peer.pc.close(); } catch { /* already closed */ }
  }
}

async function prepareFile(payload: FilesRtcConnectRequestPayload): Promise<PreparedFile> {
  const absolutePath = await resolveTarget(payload.cwd, payload.path);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error('Not a regular file.');
  if (info.size > FILE_RTC_MAX_BYTES) throw new Error('File exceeds the 64 MiB direct preview limit.');

  const dot = absolutePath.lastIndexOf('.');
  const mimeType = payload.allowImage && dot >= 0
    ? IMAGE_MIME[absolutePath.slice(dot + 1).toLowerCase()]
    : undefined;
  let kind: FileReadKind = mimeType ? 'image' : 'text';
  if (!mimeType) {
    const handle = await open(absolutePath, 'r');
    try {
      const sniff = Buffer.alloc(Math.min(SNIFF_BYTES, info.size));
      await handle.read(sniff, 0, sniff.length, 0);
      if (sniff.includes(0)) kind = 'binary';
    } finally {
      await handle.close();
    }
  }
  return {
    cwd: payload.cwd,
    path: payload.path,
    absolutePath,
    size: info.size,
    mtime: Math.floor(info.mtimeMs),
    kind,
    mimeType,
  };
}

async function resolveTarget(cwd: string, path: string): Promise<string> {
  if (path && isAbsolute(path)) return path;
  if (!cwd) throw new Error('cwd is required when path is relative.');
  return resolve(await realpath(resolve(cwd)), path || '.');
}

async function waitForWritable(channel: RTCDataChannelLike): Promise<void> {
  while ((channel.bufferedAmount ?? 0) > FILE_RTC_BUFFER_HIGH_WATER) {
    if (channel.readyState === 'closed') throw new Error('File transfer was cancelled.');
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
}

export function wireFileRtcStream(bus: FileRtcBus): FileRtcStreamManager {
  const manager = new FileRtcStreamManager(bus);
  bus.onSubscribe('/files/rtc/:transferId', { snapshot: () => null });
  bus.onCommand<FilesRtcConnectRequestPayload, FilesRtcConnectResponsePayload>(
    'files:rtc-connect',
    (payload, ctx) => manager.connect(payload, ctx.peer),
  );
  bus.onCommand<FilesRtcIceRequestPayload, FilesRtcIceResponsePayload>(
    'files:rtc-ice',
    (payload, ctx) => manager.addIce(payload, ctx.peer),
  );
  bus.onCommand<{ transferId: string }, FilesRtcCancelResponsePayload>(
    'files:rtc-cancel',
    (payload, ctx) => manager.cancel(payload.transferId, ctx.peer),
  );
  return manager;
}
