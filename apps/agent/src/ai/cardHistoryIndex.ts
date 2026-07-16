// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { Card, CardHistoryResponse } from '@sumicom/quicksave-shared';
import Database from 'better-sqlite3';
import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import { join } from 'path';

import { getCardHistoryDir, getStateDir } from '../service/singleton.js';
import {
  cleanPersistedCard,
  loadPersistedCards,
  type CardHistoryLogEntry,
} from './cardBuilder.js';

interface MetaRow {
  session_id: string;
  log_path: string;
  processed_bytes: number;
  source_size: number;
  source_mtime_ms: number;
  next_ordinal: number;
}

interface CardRow {
  card_id: string;
  timestamp: number;
  ordinal: number;
  card_json: string;
}

interface DbHandle {
  path: string;
  db: Database.Database;
  getMeta: Database.Statement;
  upsertMeta: Database.Statement;
  deleteMeta: Database.Statement;
  deleteCards: Database.Statement;
  countCards: Database.Statement;
  pageCards: Database.Statement;
  pageCardsBeforeOrdinal: Database.Statement;
  hasCardsBeforeOrdinal: Database.Statement;
  allCardIds: Database.Statement;
  getCard: Database.Statement;
  insertCard: Database.Statement;
  updateCard: Database.Statement;
  removeCard: Database.Statement;
  tx: <T>(fn: () => T) => T;
}

let handle: DbHandle | null = null;

function cardHistoryLogPath(sessionId: string): string {
  return join(getCardHistoryDir(), `${sessionId}.jsonl`);
}

function dbPath(): string {
  return join(getStateDir(), 'quicksave.db');
}

function getDb(): DbHandle {
  const path = dbPath();
  if (handle && handle.path === path) return handle;
  handle?.db.close();

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_history_meta (
      session_id TEXT PRIMARY KEY,
      log_path TEXT NOT NULL,
      processed_bytes INTEGER NOT NULL,
      source_size INTEGER NOT NULL,
      source_mtime_ms REAL NOT NULL,
      next_ordinal INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS card_history_cards (
      session_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      timestamp REAL NOT NULL,
      ordinal INTEGER NOT NULL,
      card_json TEXT NOT NULL,
      PRIMARY KEY (session_id, card_id)
    );

    CREATE INDEX IF NOT EXISTS idx_card_history_cards_order
      ON card_history_cards(session_id, timestamp, ordinal, card_id);
  `);

  const dbHandle: DbHandle = {
    path,
    db,
    getMeta: db.prepare('SELECT * FROM card_history_meta WHERE session_id = ?') as DbHandle['getMeta'],
    upsertMeta: db.prepare(`
      INSERT INTO card_history_meta (
        session_id, log_path, processed_bytes, source_size, source_mtime_ms, next_ordinal
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        log_path = excluded.log_path,
        processed_bytes = excluded.processed_bytes,
        source_size = excluded.source_size,
        source_mtime_ms = excluded.source_mtime_ms,
        next_ordinal = excluded.next_ordinal
    `) as DbHandle['upsertMeta'],
    deleteMeta: db.prepare('DELETE FROM card_history_meta WHERE session_id = ?') as DbHandle['deleteMeta'],
    deleteCards: db.prepare('DELETE FROM card_history_cards WHERE session_id = ?') as DbHandle['deleteCards'],
    countCards: db.prepare('SELECT COUNT(*) AS total FROM card_history_cards WHERE session_id = ?') as DbHandle['countCards'],
    pageCards: db.prepare(`
      SELECT card_id, timestamp, ordinal, card_json
      FROM card_history_cards
      WHERE session_id = ?
      ORDER BY timestamp ASC, ordinal ASC, card_id ASC
      LIMIT ? OFFSET ?
    `) as DbHandle['pageCards'],
    pageCardsBeforeOrdinal: db.prepare(`
      SELECT card_id, timestamp, ordinal, card_json
      FROM card_history_cards
      WHERE session_id = ? AND ordinal < ?
      ORDER BY ordinal DESC
      LIMIT ?
    `) as DbHandle['pageCardsBeforeOrdinal'],
    hasCardsBeforeOrdinal: db.prepare(`
      SELECT 1 AS present
      FROM card_history_cards
      WHERE session_id = ? AND ordinal < ?
      LIMIT 1
    `) as DbHandle['hasCardsBeforeOrdinal'],
    allCardIds: db.prepare('SELECT card_id FROM card_history_cards WHERE session_id = ?') as DbHandle['allCardIds'],
    getCard: db.prepare(`
      SELECT card_id, timestamp, ordinal, card_json
      FROM card_history_cards
      WHERE session_id = ? AND card_id = ?
    `) as DbHandle['getCard'],
    insertCard: db.prepare(`
      INSERT INTO card_history_cards (session_id, card_id, timestamp, ordinal, card_json)
      VALUES (?, ?, ?, ?, ?)
    `) as DbHandle['insertCard'],
    updateCard: db.prepare(`
      UPDATE card_history_cards
      SET timestamp = ?, card_json = ?
      WHERE session_id = ? AND card_id = ?
    `) as DbHandle['updateCard'],
    removeCard: db.prepare('DELETE FROM card_history_cards WHERE session_id = ? AND card_id = ?') as DbHandle['removeCard'],
    tx: (fn) => db.transaction(fn)(),
  };
  handle = dbHandle;
  return dbHandle;
}

function resetSessionIndex(db: DbHandle, sessionId: string): void {
  db.deleteCards.run(sessionId);
  db.deleteMeta.run(sessionId);
}

function statNumber(value: number | bigint | undefined, fallback: number): number {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBytesFrom(path: string, offset: number): Buffer {
  const stat = statSync(path);
  const size = statNumber(stat.size, 0);
  if (offset >= size) return Buffer.alloc(0);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(size - offset);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, offset);
    return bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function applyLogBuffer(
  db: DbHandle,
  sessionId: string,
  buffer: Buffer,
  startOffset: number,
  nextOrdinal: number,
): { processedBytes: number; nextOrdinal: number } {
  const text = buffer.toString('utf8');
  let cursor = 0;
  let processedBytes = startOffset;
  while (cursor < text.length) {
    const nl = text.indexOf('\n', cursor);
    if (nl < 0) break;
    const rawLine = text.slice(cursor, nl);
    processedBytes += Buffer.byteLength(text.slice(cursor, nl + 1), 'utf8');
    cursor = nl + 1;
    if (!rawLine.trim()) continue;
    try {
      const entry = JSON.parse(rawLine) as CardHistoryLogEntry;
      nextOrdinal = applyLogEntry(db, sessionId, entry, nextOrdinal);
    } catch {
      // Keep existing JSONL tolerance: malformed complete lines are ignored.
    }
  }
  return { processedBytes, nextOrdinal };
}

function applyLogEntry(
  db: DbHandle,
  sessionId: string,
  entry: CardHistoryLogEntry,
  nextOrdinal: number,
): number {
  switch (entry.op) {
    case 'seed':
      for (const card of entry.cards ?? []) {
        if (!card?.id || (db.getCard.get(sessionId, card.id) as CardRow | undefined)) continue;
        insertCard(db, sessionId, cleanPersistedCard(card), nextOrdinal++);
      }
      return nextOrdinal;
    case 'upsert': {
      if (!entry.card?.id) return nextOrdinal;
      const card = cleanPersistedCard(entry.card);
      const existing = db.getCard.get(sessionId, card.id) as CardRow | undefined;
      if (existing) updateCard(db, sessionId, card);
      else insertCard(db, sessionId, card, nextOrdinal++);
      return nextOrdinal;
    }
    case 'patch': {
      const existing = db.getCard.get(sessionId, entry.cardId) as CardRow | undefined;
      if (!existing) return nextOrdinal;
      const card = parseCard(existing.card_json);
      if (!card) return nextOrdinal;
      const bag = card as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(entry.patch ?? {})) {
        if (value === null) delete bag[key];
        else bag[key] = value;
      }
      updateCard(db, sessionId, cleanPersistedCard(card));
      return nextOrdinal;
    }
    case 'append_text': {
      const existing = db.getCard.get(sessionId, entry.cardId) as CardRow | undefined;
      if (!existing) return nextOrdinal;
      const card = parseCard(existing.card_json);
      if (!card || !('text' in card)) return nextOrdinal;
      (card as { text: string }).text += entry.text;
      updateCard(db, sessionId, cleanPersistedCard(card));
      return nextOrdinal;
    }
    case 'remove':
      db.removeCard.run(sessionId, entry.cardId);
      return nextOrdinal;
  }
}

function insertCard(db: DbHandle, sessionId: string, card: Card, ordinal: number): void {
  db.insertCard.run(sessionId, card.id, cardTimestamp(card), ordinal, JSON.stringify(card));
}

function updateCard(db: DbHandle, sessionId: string, card: Card): void {
  db.updateCard.run(cardTimestamp(card), JSON.stringify(card), sessionId, card.id);
}

function parseCard(raw: string): Card | null {
  try {
    const parsed = JSON.parse(raw) as Card;
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

function cardTimestamp(card: Card): number {
  return Number.isFinite(card.timestamp) ? Number(card.timestamp) : 0;
}

function syncIndex(sessionId: string): boolean {
  const logPath = cardHistoryLogPath(sessionId);
  if (!existsSync(logPath)) return false;

  const stat = statSync(logPath);
  const sourceSize = statNumber(stat.size, 0);
  const sourceMtimeMs = statNumber(stat.mtimeMs, 0);
  const db = getDb();

  try {
    return syncIndexWithDb(db, sessionId, logPath, sourceSize, sourceMtimeMs, false);
  } catch {
    try {
      return syncIndexWithDb(db, sessionId, logPath, sourceSize, sourceMtimeMs, true);
    } catch {
      return false;
    }
  }
}

function syncIndexWithDb(
  db: DbHandle,
  sessionId: string,
  logPath: string,
  sourceSize: number,
  sourceMtimeMs: number,
  forceRebuild: boolean,
): boolean {
  return db.tx(() => {
    let meta = forceRebuild ? undefined : (db.getMeta.get(sessionId) as MetaRow | undefined);
    if (!meta || meta.log_path !== logPath || sourceSize < meta.processed_bytes) {
      resetSessionIndex(db, sessionId);
      meta = {
        session_id: sessionId,
        log_path: logPath,
        processed_bytes: 0,
        source_size: 0,
        source_mtime_ms: 0,
        next_ordinal: 0,
      };
    }

    if (sourceSize > meta.processed_bytes) {
      const buffer = readBytesFrom(logPath, meta.processed_bytes);
      const result = applyLogBuffer(db, sessionId, buffer, meta.processed_bytes, meta.next_ordinal);
      meta = {
        ...meta,
        processed_bytes: result.processedBytes,
        next_ordinal: result.nextOrdinal,
      };
    }

    db.upsertMeta.run(
      sessionId,
      logPath,
      meta.processed_bytes,
      sourceSize,
      sourceMtimeMs,
      meta.next_ordinal,
    );
    return true;
  });
}

export async function loadPersistedCardPage(
  sessionId: string,
  offset = 0,
  limit = 50,
): Promise<CardHistoryResponse> {
  if (!syncIndex(sessionId)) {
    const cards = await loadPersistedCards(sessionId);
    const total = cards.length;
    const start = Math.max(0, total - offset - limit);
    const end = Math.max(0, total - offset);
    return { cards: cards.slice(start, end), total, hasMore: start > 0 };
  }

  const db = getDb();
  const total = (db.countCards.get(sessionId) as { total: number } | undefined)?.total ?? 0;
  const start = Math.max(0, total - offset - limit);
  const rows = db.pageCards.all(sessionId, limit, start) as CardRow[];
  return {
    cards: rows.map((row) => JSON.parse(row.card_json) as Card),
    total,
    hasMore: start > 0,
  };
}

const MEMORY_ORDINAL_CURSOR_PREFIX = 'memory-ordinal:';
const MEMORY_OFFSET_CURSOR_PREFIX = 'memory-offset:';

export interface PersistedCardCursorPage extends CardHistoryResponse {
  /** Number of supplied live card ids already represented on disk. */
  persistedLiveCount: number;
}

function parseCursorNumber(cursor: string | undefined, prefix: string): number | null {
  if (!cursor?.startsWith(prefix)) return null;
  const value = Number(cursor.slice(prefix.length));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Load a stable page from memory-mode history.
 *
 * SQLite ordinals are immutable insertion positions, so the returned cursor
 * remains valid if newer live cards are appended or removed after the
 * snapshot. On the initial active-turn snapshot, `liveCardIds` moves the
 * boundary before the earliest persisted live card; the caller can append
 * the complete in-memory turn without duplicating or skipping history.
 */
export async function loadPersistedCardCursorPage(
  sessionId: string,
  opts: {
    cursor?: string;
    limit?: number;
    liveCardIds?: readonly string[];
  } = {},
): Promise<PersistedCardCursorPage> {
  const limit = Math.max(0, Math.floor(opts.limit ?? 50));
  const liveIds = opts.liveCardIds ?? [];

  if (!syncIndex(sessionId)) {
    const cards = await loadPersistedCards(sessionId);
    // Reading a legacy `.json` snapshot migrates it to JSONL. Build the
    // ordinal index immediately so the first response never hands out an
    // offset cursor that changes meaning on the next request.
    if (syncIndex(sessionId)) {
      return loadPersistedCardCursorPage(sessionId, opts);
    }
    const cursorOffset = parseCursorNumber(opts.cursor, MEMORY_OFFSET_CURSOR_PREFIX);
    const liveIdSet = new Set(liveIds);
    let persistedLiveCount = 0;
    let firstLiveIndex = cards.length;
    if (liveIdSet.size > 0) {
      for (let i = 0; i < cards.length; i++) {
        if (!liveIdSet.has(cards[i].id)) continue;
        persistedLiveCount++;
        if (cursorOffset == null) firstLiveIndex = Math.min(firstLiveIndex, i);
      }
    }
    const boundary = Math.min(cards.length, cursorOffset ?? firstLiveIndex);
    const start = Math.max(0, boundary - limit);
    const hasMore = start > 0;
    return {
      cards: cards.slice(start, boundary),
      total: cards.length,
      hasMore,
      ...(hasMore ? { nextCursor: `${MEMORY_OFFSET_CURSOR_PREFIX}${start}` } : {}),
      persistedLiveCount,
    };
  }

  const db = getDb();
  const legacyOffsetCursor = parseCursorNumber(opts.cursor, MEMORY_OFFSET_CURSOR_PREFIX);
  if (legacyOffsetCursor != null) {
    const page = await loadPersistedCardPage(sessionId, legacyOffsetCursor, limit);
    return {
      ...page,
      ...(page.hasMore
        ? { nextCursor: `${MEMORY_OFFSET_CURSOR_PREFIX}${legacyOffsetCursor + page.cards.length}` }
        : {}),
      persistedLiveCount: 0,
    };
  }
  const ordinalCursor = parseCursorNumber(opts.cursor, MEMORY_ORDINAL_CURSOR_PREFIX);
  const meta = db.getMeta.get(sessionId) as MetaRow | undefined;
  let boundary = ordinalCursor ?? meta?.next_ordinal ?? Number.MAX_SAFE_INTEGER;
  let persistedLiveCount = 0;

  if (liveIds.length > 0) {
    for (const cardId of new Set(liveIds)) {
      const row = db.getCard.get(sessionId, cardId) as CardRow | undefined;
      if (!row) continue;
      persistedLiveCount++;
      if (ordinalCursor == null) boundary = Math.min(boundary, row.ordinal);
    }
  }

  const descendingRows = db.pageCardsBeforeOrdinal.all(
    sessionId,
    boundary,
    limit,
  ) as CardRow[];
  const rows = descendingRows.reverse();
  const nextBoundary = rows[0]?.ordinal ?? boundary;
  const hasMore = Boolean(db.hasCardsBeforeOrdinal.get(sessionId, nextBoundary));
  const total = (db.countCards.get(sessionId) as { total: number } | undefined)?.total ?? 0;

  return {
    cards: rows.map((row) => JSON.parse(row.card_json) as Card),
    total,
    hasMore,
    ...(hasMore ? { nextCursor: `${MEMORY_ORDINAL_CURSOR_PREFIX}${nextBoundary}` } : {}),
    persistedLiveCount,
  };
}

export async function loadPersistedCardMaxSequence(sessionId: string): Promise<number> {
  if (!syncIndex(sessionId)) {
    return maxCardSequenceForSession(await loadPersistedCards(sessionId), sessionId);
  }
  const db = getDb();
  return maxSequenceFromIds(
    (db.allCardIds.all(sessionId) as { card_id: string }[]).map((row) => row.card_id),
    sessionId,
  );
}

function maxCardSequenceForSession(cards: readonly Card[], sessionId: string): number {
  return maxSequenceFromIds(cards.map((card) => card.id), sessionId);
}

function maxSequenceFromIds(ids: readonly string[], sessionId: string): number {
  const prefix = `${sessionId}:`;
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const raw = id.slice(prefix.length);
    if (!/^\d+$/.test(raw)) continue;
    const seq = Number(raw);
    if (Number.isSafeInteger(seq) && seq > max) max = seq;
  }
  return max;
}

export function closeCardHistoryIndexForTests(): void {
  handle?.db.close();
  handle = null;
}
