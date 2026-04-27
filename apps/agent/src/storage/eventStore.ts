/**
 * Event store — append-only SQLite log of session activity.
 *
 * Storage: ~/.quicksave/state/quicksave.db
 *
 * Schema:
 *   events (id, time, session_id, cwd, type, data)
 *   Indexes on (session_id, time), (type, time), (time).
 *
 * Intended as a long-lived audit/analytics log. Derived stats (cumulative
 * tokens, cost, last prompt time) are computed via aggregate queries.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { getStateDir } from '../service/singleton.js';

export type EventType =
  | 'prompt_sent'
  | 'turn_ended'
  | 'permission_requested'
  | 'permission_resolved'
  | 'session_cancelled'
  /** Anthropic prompt cache hit/write — recorded (throttled) so the PWA's
   *  cache-TTL countdown survives a daemon restart. With the 1h extended-TTL
   *  setting the cache window is long enough that a restart inside it is
   *  realistic; without persistence we'd lose the anchor and over-count
   *  remaining time off `lastTurnEndedAt`. */
  | 'cache_touched';

export interface EventRecord {
  id: number;
  time: number;
  sessionId: string | null;
  cwd: string | null;
  type: EventType;
  data: unknown;
}

export interface SessionStats {
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  lastPromptAt: number | null;
  lastTurnEndedAt: number | null;
  /** MAX(time) of `cache_touched` events for this session. Most reliable anchor
   *  for the prompt-cache countdown — see EventType comment. */
  lastCacheTouchAt: number | null;
}

export interface LastTurnInfo {
  time: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /** Codex-only: thread-cumulative token counts at end of this turn. Used to
   *  compute per-turn deltas after a daemon restart. Absent for Claude turns
   *  and for codex turns recorded before this field was introduced. */
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeCachedInputTokens?: number;
  /** Category-level context-window breakdown from the provider. Shape mirrors
   * `ContextUsageBreakdown` in @sumicom/quicksave-shared. Present only when
   * the CLI answered `get_context_usage` successfully at turn end. */
  contextUsage?: unknown;
}

interface EventRow {
  id: number;
  time: number;
  session_id: string | null;
  cwd: string | null;
  type: string;
  data: string | null;
}

export class EventStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private statsStmt: Database.Statement;
  private lastPromptStmt: Database.Statement;
  private lastCacheTouchStmt: Database.Statement;
  private sessionEventsStmt: Database.Statement;
  private lastTurnStmt: Database.Statement;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time INTEGER NOT NULL,
        session_id TEXT,
        cwd TEXT,
        type TEXT NOT NULL,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(session_id, time);
      CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(type, time);
      CREATE INDEX IF NOT EXISTS idx_events_time ON events(time);
    `);

    this.insertStmt = this.db.prepare(
      'INSERT INTO events (time, session_id, cwd, type, data) VALUES (?, ?, ?, ?, ?)'
    );

    this.statsStmt = this.db.prepare(`
      SELECT
        COUNT(*) AS turnCount,
        COALESCE(SUM(CAST(json_extract(data, '$.inputTokens') AS INTEGER)), 0) AS totalInputTokens,
        COALESCE(SUM(CAST(json_extract(data, '$.outputTokens') AS INTEGER)), 0) AS totalOutputTokens,
        COALESCE(SUM(CAST(json_extract(data, '$.costUsd') AS REAL)), 0) AS totalCostUsd,
        MAX(time) AS lastTurnEndedAt
      FROM events
      WHERE session_id = ? AND type = 'turn_ended'
    `);

    this.lastPromptStmt = this.db.prepare(
      `SELECT MAX(time) AS lastPromptAt FROM events WHERE session_id = ? AND type = 'prompt_sent'`
    );

    // The countdown anchor falls back through `cache_touched → turn_ended →
    // prompt_sent`, so a session with no `cache_touched` events (older
    // sessions, non-Claude providers) silently drops to `lastTurnEndedAt`.
    this.lastCacheTouchStmt = this.db.prepare(
      `SELECT MAX(time) AS lastCacheTouchAt FROM events WHERE session_id = ? AND type = 'cache_touched'`
    );

    this.sessionEventsStmt = this.db.prepare(
      `SELECT id, time, session_id, cwd, type, data FROM events WHERE session_id = ? ORDER BY time ASC, id ASC LIMIT ? OFFSET ?`
    );

    this.lastTurnStmt = this.db.prepare(
      `SELECT time, data FROM events WHERE session_id = ? AND type = 'turn_ended' ORDER BY time DESC, id DESC LIMIT 1`
    );
  }

  record(params: {
    type: EventType;
    sessionId?: string | null;
    cwd?: string | null;
    data?: unknown;
    time?: number;
  }): void {
    const time = params.time ?? Date.now();
    const data = params.data === undefined ? null : JSON.stringify(params.data);
    this.insertStmt.run(time, params.sessionId ?? null, params.cwd ?? null, params.type, data);
  }

  getSessionStats(sessionId: string): SessionStats {
    const turnRow = this.statsStmt.get(sessionId) as {
      turnCount: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCostUsd: number;
      lastTurnEndedAt: number | null;
    };
    const promptRow = this.lastPromptStmt.get(sessionId) as { lastPromptAt: number | null };
    const cacheRow = this.lastCacheTouchStmt.get(sessionId) as { lastCacheTouchAt: number | null };
    return {
      turnCount: turnRow.turnCount,
      totalInputTokens: turnRow.totalInputTokens,
      totalOutputTokens: turnRow.totalOutputTokens,
      totalCostUsd: turnRow.totalCostUsd,
      lastPromptAt: promptRow.lastPromptAt,
      lastTurnEndedAt: turnRow.lastTurnEndedAt,
      lastCacheTouchAt: cacheRow.lastCacheTouchAt,
    };
  }

  getSessionEvents(sessionId: string, limit = 500, offset = 0): EventRecord[] {
    const rows = this.sessionEventsStmt.all(sessionId, limit, offset) as EventRow[];
    return rows.map(rowToRecord);
  }

  getLastTurn(sessionId: string): LastTurnInfo | null {
    const row = this.lastTurnStmt.get(sessionId) as { time: number; data: string | null } | undefined;
    if (!row) return null;
    const data = row.data ? JSON.parse(row.data) : {};
    return {
      time: row.time,
      inputTokens: Number(data.inputTokens ?? 0),
      outputTokens: Number(data.outputTokens ?? 0),
      cacheCreationTokens: Number(data.cacheCreationTokens ?? 0),
      cacheReadTokens: Number(data.cacheReadTokens ?? 0),
      costUsd: Number(data.costUsd ?? 0),
      cumulativeInputTokens: typeof data.cumulativeInputTokens === 'number' ? data.cumulativeInputTokens : undefined,
      cumulativeOutputTokens: typeof data.cumulativeOutputTokens === 'number' ? data.cumulativeOutputTokens : undefined,
      cumulativeCachedInputTokens: typeof data.cumulativeCachedInputTokens === 'number' ? data.cumulativeCachedInputTokens : undefined,
      contextUsage: data.contextUsage ?? undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    time: row.time,
    sessionId: row.session_id,
    cwd: row.cwd,
    type: row.type as EventType,
    data: row.data ? JSON.parse(row.data) : null,
  };
}

let instance: EventStore | null = null;

export function getEventStore(): EventStore {
  if (!instance) {
    instance = new EventStore(join(getStateDir(), 'quicksave.db'));
  }
  return instance;
}

/** Reset the singleton — only for tests. */
export function resetEventStore(): void {
  if (instance) instance.close();
  instance = null;
}
