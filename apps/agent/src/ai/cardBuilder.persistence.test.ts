// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import type { Card } from '@sumicom/quicksave-shared';
import { setQuicksaveDir } from '../service/singleton.js';
import { loadPersistedCards, StreamCardBuilder } from './cardBuilder.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'card-history-persist-'));
  setQuicksaveDir(tempDir);
});

afterEach(() => {
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
});
