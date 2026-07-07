// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

import type { Card } from '@sumicom/quicksave-shared';
import { setQuicksaveDir } from '../service/singleton.js';
import { loadPersistedCards, StreamCardBuilder } from './cardBuilder.js';
import { closeCardHistoryIndexForTests, loadPersistedCardPage } from './cardHistoryIndex.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'card-history-persist-'));
  setQuicksaveDir(tempDir);
});

afterEach(() => {
  closeCardHistoryIndexForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

function cardHistoryDir(): string {
  return join(tempDir, 'state', 'card-history');
}

describe('memory-mode card history persistence', () => {
  it('appends card mutations immediately and flushes them on demand', async () => {
    const builder = new StreamCardBuilder('sess-live', '/cwd');
    builder.enableMemoryPersistence();

    builder.userMessage('hello');
    builder.assistantText('answer');
    builder.assistantText(' continues');
    builder.finalizeAssistantText();

    await builder.flushCardHistoryWrites();

    const logPath = join(cardHistoryDir(), 'sess-live.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).op)).toEqual(['upsert', 'upsert', 'append_text', 'patch']);

    const cards = await loadPersistedCards('sess-live');
    expect(cards.map((card) => card.type)).toEqual(['user', 'assistant_text']);
    expect((cards[0] as { text: string }).text).toBe('hello');
    expect((cards[1] as { text: string; streaming?: boolean }).text).toBe('answer continues');
    expect((cards[1] as { streaming?: boolean }).streaming).toBe(false);
  });

  it('migrates the legacy JSON array snapshot to append-only JSONL on read', async () => {
    mkdirSync(cardHistoryDir(), { recursive: true });
    const legacyCards: Card[] = [
      { type: 'user', id: 'legacy:1', timestamp: 1, text: 'old prompt' },
      { type: 'assistant_text', id: 'legacy:2', timestamp: 2, text: 'old reply', streaming: false },
    ];
    const legacyPath = join(cardHistoryDir(), 'legacy.json');
    writeFileSync(legacyPath, JSON.stringify(legacyCards) + '\n');

    const cards = await loadPersistedCards('legacy');

    expect(cards.map((card) => (card as { text?: string }).text)).toEqual(['old prompt', 'old reply']);
    expect(existsSync(join(cardHistoryDir(), 'legacy.jsonl'))).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);

    const secondRead = await loadPersistedCards('legacy');
    expect(secondRead).toHaveLength(2);
    expect(secondRead.map((card) => card.id)).toEqual(['legacy:1', 'legacy:2']);
  });

  it('keeps the legacy snapshot mtime when migrating to JSONL', async () => {
    mkdirSync(cardHistoryDir(), { recursive: true });
    const legacyCards: Card[] = [
      { type: 'user', id: 'legacy-mtime:1', timestamp: 1, text: 'old prompt' },
    ];
    const legacyPath = join(cardHistoryDir(), 'legacy-mtime.json');
    const logPath = join(cardHistoryDir(), 'legacy-mtime.jsonl');
    writeFileSync(legacyPath, JSON.stringify(legacyCards) + '\n');
    const legacyTime = new Date('2026-05-01T12:00:00.000Z');
    utimesSync(legacyPath, legacyTime, legacyTime);

    await loadPersistedCards('legacy-mtime');

    expect(existsSync(logPath)).toBe(true);
    expect(Math.abs(statSync(logPath).mtimeMs - legacyTime.getTime())).toBeLessThan(1000);
  });

  it('repairs JSONL mtime for histories already migrated by the old code', async () => {
    mkdirSync(cardHistoryDir(), { recursive: true });
    const cards: Card[] = [
      { type: 'user', id: 'already-migrated:1', timestamp: 1, text: 'old prompt' },
    ];
    const legacyTime = new Date('2026-05-01T12:00:00.000Z');
    const migratedAt = new Date('2026-06-03T10:30:00.000Z');
    const logPath = join(cardHistoryDir(), 'already-migrated.jsonl');
    const migratedPath = join(cardHistoryDir(), `already-migrated.json.migrated-${migratedAt.getTime()}`);
    writeFileSync(logPath, JSON.stringify({ op: 'seed', cards }) + '\n');
    writeFileSync(migratedPath, JSON.stringify(cards) + '\n');
    utimesSync(logPath, migratedAt, migratedAt);
    utimesSync(migratedPath, legacyTime, legacyTime);

    await loadPersistedCards('already-migrated');

    expect(Math.abs(statSync(logPath).mtimeMs - legacyTime.getTime())).toBeLessThan(1000);
  });

  it('serves card pages from a durable JSONL offset index', async () => {
    mkdirSync(cardHistoryDir(), { recursive: true });
    const logPath = join(cardHistoryDir(), 'indexed.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 80; i++) {
      const card: Card = { type: 'user', id: `indexed:${i + 1}`, timestamp: i + 1, text: `msg-${i}` };
      lines.push(JSON.stringify({ op: 'upsert', card }) + '\n');
    }
    writeFileSync(logPath, lines.join(''));

    const first = await loadPersistedCardPage('indexed', 0, 10);
    expect(first.total).toBe(80);
    expect(first.cards.map((card) => (card as { text?: string }).text)).toEqual([
      'msg-70',
      'msg-71',
      'msg-72',
      'msg-73',
      'msg-74',
      'msg-75',
      'msg-76',
      'msg-77',
      'msg-78',
      'msg-79',
    ]);

    const db = new Database(join(tempDir, 'state', 'quicksave.db'), { readonly: true });
    const firstMeta = db.prepare('SELECT processed_bytes FROM card_history_meta WHERE session_id = ?').get('indexed') as { processed_bytes: number };
    db.close();
    expect(firstMeta.processed_bytes).toBe(statSync(logPath).size);

    appendFileSync(logPath, JSON.stringify({
      op: 'upsert',
      card: { type: 'user', id: 'indexed:81', timestamp: 81, text: 'msg-80' },
    }) + '\n');

    const second = await loadPersistedCardPage('indexed', 0, 10);
    expect(second.total).toBe(81);
    expect(second.cards.at(-1)).toMatchObject({ id: 'indexed:81', text: 'msg-80' });
  });

  it('rebuilds the durable index when the JSONL is truncated or replaced', async () => {
    mkdirSync(cardHistoryDir(), { recursive: true });
    const logPath = join(cardHistoryDir(), 'truncated.jsonl');
    writeFileSync(logPath, [
      JSON.stringify({ op: 'upsert', card: { type: 'user', id: 'truncated:1', timestamp: 1, text: 'old-1' } }),
      JSON.stringify({ op: 'upsert', card: { type: 'user', id: 'truncated:2', timestamp: 2, text: 'old-2' } }),
      '',
    ].join('\n'));

    const first = await loadPersistedCardPage('truncated', 0, 50);
    expect(first.total).toBe(2);

    writeFileSync(logPath, JSON.stringify({
      op: 'upsert',
      card: { type: 'user', id: 'truncated:1', timestamp: 10, text: 'new-only' },
    }) + '\n');

    const second = await loadPersistedCardPage('truncated', 0, 50);
    expect(second.total).toBe(1);
    expect(second.cards).toEqual([
      expect.objectContaining({ id: 'truncated:1', text: 'new-only' }),
    ]);
  });
});
