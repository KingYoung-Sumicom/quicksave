// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { VoiceAgentTraceEntry } from '@sumicom/quicksave-shared';
import { getStateDir } from '../../service/singleton.js';

const DEFAULT_READ_LIMIT = 200;

/** Append-only, daemon-owned debug timeline. It is deliberately separate from
 * the worker-owned model context history so reloads cannot race sequence IDs. */
export class VoiceDebugStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir = join(getStateDir(), 'voice-debug')) {}

  async append(sessionId: string, entry: VoiceAgentTraceEntry): Promise<void> {
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.rootDir, { recursive: true });
        await appendFile(this.path(sessionId), `${JSON.stringify(entry)}\n`, 'utf8');
      })
      .catch((error) => {
        console.error(`[voice-debug] append failed session=${sessionId}:`, error);
      });
    await this.writeQueue;
  }

  async read(sessionId: string, limit = DEFAULT_READ_LIMIT): Promise<VoiceAgentTraceEntry[]> {
    await this.writeQueue.catch(() => undefined);
    const path = this.path(sessionId);
    if (!existsSync(path)) return [];
    try {
      const entries: VoiceAgentTraceEntry[] = [];
      for (const line of (await readFile(path, 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as VoiceAgentTraceEntry;
          if (isTraceEntry(parsed)) entries.push(parsed);
        } catch {
          // An interrupted final append must not hide earlier diagnostics.
        }
      }
      return entries.slice(-Math.max(1, limit));
    } catch {
      return [];
    }
  }

  private path(sessionId: string): string {
    return join(this.rootDir, `${sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`);
  }
}

function isTraceEntry(value: unknown): value is VoiceAgentTraceEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<VoiceAgentTraceEntry>;
  return typeof entry.id === 'string'
    && Number.isFinite(entry.timestamp)
    && typeof entry.event === 'string'
    && ['context', 'llm', 'tool', 'speech', 'lifecycle'].includes(entry.phase ?? '');
}
