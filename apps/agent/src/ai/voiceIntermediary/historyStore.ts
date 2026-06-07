// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import { appendFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getStateDir } from '../../service/singleton.js';
import type { ChatMessage } from './llm.js';

export type VoiceHistoryEvent =
  | { type: 'chat_message'; seq: number; ts: number; message: ChatMessage }
  | { type: 'compaction_boundary'; seq: number; ts: number; before_seq: number; summary: string; message_count: number }
  | { type: 'runtime_event'; seq: number; ts: number; event: string; data?: unknown };

type VoiceHistoryEventInput =
  | { type: 'chat_message'; message: ChatMessage }
  | { type: 'compaction_boundary'; before_seq: number; summary: string; message_count: number }
  | { type: 'runtime_event'; event: string; data?: unknown };

export interface VoiceHistoryRestore {
  events: VoiceHistoryEvent[];
  activeMessages: ChatMessage[];
  compactionSummary: string;
  latestSeq: number;
}

export interface VoiceHistoryReadOptions {
  query?: string;
  limit?: number;
  beforeSeq?: number;
  includeRuntimeEvents?: boolean;
}

export class VoiceHistoryStore {
  private seq = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized: Promise<void> | null = null;

  constructor(private readonly sessionId: string, private readonly rootDir = defaultVoiceHistoryDir()) {}

  async restore(): Promise<VoiceHistoryRestore> {
    const events = await this.loadEvents();
    this.seq = Math.max(this.seq, ...events.map((e) => e.seq), 0);
    return restoreFromEvents(events);
  }

  latestSeq(): number {
    return this.seq;
  }

  async appendChatMessage(message: ChatMessage): Promise<VoiceHistoryEvent> {
    return this.append({ type: 'chat_message', message });
  }

  async appendCompactionBoundary(summary: string, beforeSeq: number, messageCount: number): Promise<VoiceHistoryEvent> {
    return this.append({
      type: 'compaction_boundary',
      before_seq: beforeSeq,
      summary,
      message_count: messageCount,
    });
  }

  async appendRuntimeEvent(event: string, data?: unknown): Promise<VoiceHistoryEvent> {
    return this.append({ type: 'runtime_event', event, ...(data !== undefined ? { data } : {}) });
  }

  async read(opts: VoiceHistoryReadOptions = {}): Promise<VoiceHistoryEvent[]> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const query = opts.query?.toLowerCase().trim();
    let events = await this.loadEvents();
    if (opts.beforeSeq !== undefined) events = events.filter((e) => e.seq < opts.beforeSeq!);
    if (!opts.includeRuntimeEvents) events = events.filter((e) => e.type !== 'runtime_event');
    if (query) events = events.filter((e) => eventSearchText(e).toLowerCase().includes(query));
    return events.slice(-limit);
  }

  async flush(): Promise<void> {
    await this.writeQueue.catch(() => undefined);
  }

  private async append(event: VoiceHistoryEventInput): Promise<VoiceHistoryEvent> {
    await this.ensureInitialized();
    const next = { ...event, seq: ++this.seq, ts: Date.now() } as VoiceHistoryEvent;
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.rootDir, { recursive: true });
        await appendFile(this.path(), `${JSON.stringify(next)}\n`, 'utf8');
      })
      .catch((err) => {
        console.error(`[voice-history] append failed session=${this.sessionId}:`, err);
      });
    await this.writeQueue;
    return next;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.restore().then(() => undefined);
    }
    await this.initialized;
  }

  private path(): string {
    return join(this.rootDir, `${sanitizeSessionId(this.sessionId)}.jsonl`);
  }

  private async loadEvents(): Promise<VoiceHistoryEvent[]> {
    const path = this.path();
    if (!existsSync(path)) return [];
    try {
      const raw = await readFile(path, 'utf8');
      const events: VoiceHistoryEvent[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as VoiceHistoryEvent;
          if (isVoiceHistoryEvent(parsed)) events.push(parsed);
        } catch {
          // Skip malformed lines; append-only history must tolerate partial writes.
        }
      }
      return events.sort((a, b) => a.seq - b.seq);
    } catch {
      return [];
    }
  }
}

export function restoreFromEvents(events: readonly VoiceHistoryEvent[]): VoiceHistoryRestore {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const latestSeq = sorted.reduce((max, e) => Math.max(max, e.seq), 0);
  const latestBoundary = [...sorted].reverse().find((e): e is Extract<VoiceHistoryEvent, { type: 'compaction_boundary' }> =>
    e.type === 'compaction_boundary',
  );
  const after = latestBoundary
    ? sorted.filter((e) => e.seq > latestBoundary.seq)
    : sorted;
  return {
    events: sorted,
    activeMessages: after
      .filter((e): e is Extract<VoiceHistoryEvent, { type: 'chat_message' }> => e.type === 'chat_message')
      .map((e) => e.message),
    compactionSummary: latestBoundary?.summary ?? '',
    latestSeq,
  };
}

export function formatVoiceHistoryEvent(event: VoiceHistoryEvent): string {
  switch (event.type) {
    case 'chat_message':
      return `[${event.seq}] ${event.message.role}: ${truncate(messageText(event.message), 240)}`;
    case 'compaction_boundary':
      return `[${event.seq}] [compaction] ${truncate(event.summary, 300)}`;
    case 'runtime_event':
      return `[${event.seq}] [event] ${event.event}${event.data === undefined ? '' : ` ${truncate(JSON.stringify(event.data), 160)}`}`;
  }
}

function defaultVoiceHistoryDir(): string {
  return join(getStateDir(), 'voice-history');
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isVoiceHistoryEvent(value: unknown): value is VoiceHistoryEvent {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<VoiceHistoryEvent>;
  if (!Number.isFinite(record.seq) || !Number.isFinite(record.ts)) return false;
  return record.type === 'chat_message' || record.type === 'compaction_boundary' || record.type === 'runtime_event';
}

function eventSearchText(event: VoiceHistoryEvent): string {
  if (event.type === 'chat_message') return `${event.message.role} ${messageText(event.message)}`;
  if (event.type === 'compaction_boundary') return event.summary;
  return `${event.event} ${event.data === undefined ? '' : JSON.stringify(event.data)}`;
}

function messageText(message: ChatMessage): string {
  const calls = message.tool_calls?.map((c) => `${c.function.name} ${c.function.arguments}`).join(' ') ?? '';
  return [message.content ?? '', calls].filter(Boolean).join(' ');
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}
