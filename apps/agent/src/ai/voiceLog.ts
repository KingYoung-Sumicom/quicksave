// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getLogsDir } from '../service/singleton.js';
import { isDebugEnabled } from '../service/types.js';

type VoiceLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface VoiceLogEntry {
  sessionId?: string;
  event: string;
  level?: VoiceLogLevel;
  phase?: string;
  turnId?: string;
  data?: Record<string, unknown>;
}

const MAX_TEXT_CHARS = Number(process.env.QUICKSAVE_VOICE_LOG_MAX_TEXT_CHARS ?? 2048);

function enabled(): boolean {
  const env = process.env.QUICKSAVE_VOICE_LOG?.trim();
  if (env === '1') return true;
  if (env === '0') return false;
  return isDebugEnabled() && process.env.NODE_ENV !== 'test';
}

function shortSessionId(sessionId: string | undefined): string {
  if (!sessionId) return 'unknown';
  return sessionId.length > 12 ? sessionId.slice(0, 12) : sessionId;
}

function dayStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= MAX_TEXT_CHARS) return value;
    return `${value.slice(0, MAX_TEXT_CHARS)}…`;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/apiKey|authorization|token|secret|audioBase64|audio/i.test(key)) {
      if (/audioBytes|audioId/i.test(key)) out[key] = sanitize(raw);
      else out[key] = '[redacted]';
      continue;
    }
    out[key] = sanitize(raw);
  }
  return out;
}

export class VoiceEventLogger {
  constructor(private readonly isEnabled = enabled) {}

  log(entry: VoiceLogEntry): void {
    if (!this.isEnabled()) return;
    const line = JSON.stringify({
      v: 1,
      ts: new Date().toISOString(),
      source: 'voice',
      level: entry.level ?? 'info',
      sessionId: entry.sessionId,
      event: entry.event,
      phase: entry.phase,
      turnId: entry.turnId,
      data: sanitize(entry.data ?? {}),
    });
    const dir = join(getLogsDir(), 'voice', dayStamp());
    const file = join(dir, `${shortSessionId(entry.sessionId)}.jsonl`);
    void mkdir(dir, { recursive: true })
      .then(() => appendFile(file, `${line}\n`, 'utf8'))
      .catch(() => undefined);
  }
}

export const voiceEventLogger = new VoiceEventLogger();
