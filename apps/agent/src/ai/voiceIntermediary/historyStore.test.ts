// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setQuicksaveDir } from '../../service/singleton.js';
import { formatVoiceHistoryEvent, restoreFromEvents, VoiceHistoryStore } from './historyStore.js';

describe('VoiceHistoryStore', () => {
  let quicksaveDir: string;

  beforeEach(async () => {
    quicksaveDir = await mkdtemp(join(tmpdir(), 'qs-voice-history-'));
    setQuicksaveDir(quicksaveDir);
  });

  afterEach(async () => {
    await rm(quicksaveDir, { recursive: true, force: true });
  });

  it('persists chat messages and restores the active window', async () => {
    const store = new VoiceHistoryStore('s1');
    await store.appendChatMessage({ role: 'user', content: '第一句' });
    await store.appendChatMessage({ role: 'assistant', content: '回答一' });

    const restored = await new VoiceHistoryStore('s1').restore();

    expect(restored.activeMessages.map((m) => m.content)).toEqual(['第一句', '回答一']);
    expect(restored.latestSeq).toBe(2);
  });

  it('restores messages after the latest compaction boundary only', async () => {
    const store = new VoiceHistoryStore('s1');
    await store.appendChatMessage({ role: 'user', content: '舊問題' });
    await store.appendChatMessage({ role: 'assistant', content: '舊回答' });
    await store.appendCompactionBoundary('舊問題已回答', store.latestSeq(), 2);
    await store.appendChatMessage({ role: 'user', content: '保留問題' });

    const restored = await new VoiceHistoryStore('s1').restore();

    expect(restored.compactionSummary).toBe('舊問題已回答');
    expect(restored.activeMessages.map((m) => m.content)).toEqual(['保留問題']);
  });

  it('reads compacted history by query and sequence cursor', async () => {
    const store = new VoiceHistoryStore('s1');
    await store.appendChatMessage({ role: 'user', content: 'alpha 舊問題' });
    const boundary = await store.appendCompactionBoundary('alpha summary', store.latestSeq(), 1);
    await store.appendChatMessage({ role: 'assistant', content: 'beta 新回答' });

    const alpha = await new VoiceHistoryStore('s1').read({ query: 'alpha', limit: 10 });
    const before = await new VoiceHistoryStore('s1').read({ beforeSeq: boundary.seq, limit: 10 });

    expect(alpha.map(formatVoiceHistoryEvent).join('\n')).toContain('alpha');
    expect(before.map(formatVoiceHistoryEvent).join('\n')).toContain('alpha 舊問題');
    expect(before.map(formatVoiceHistoryEvent).join('\n')).not.toContain('beta 新回答');
  });

  it('computes restore state from arbitrary event order', () => {
    const restored = restoreFromEvents([
      { type: 'chat_message', seq: 3, ts: 3, message: { role: 'user', content: 'after' } },
      { type: 'chat_message', seq: 1, ts: 1, message: { role: 'user', content: 'before' } },
      { type: 'compaction_boundary', seq: 2, ts: 2, before_seq: 1, summary: 'summary', message_count: 1 },
    ]);

    expect(restored.compactionSummary).toBe('summary');
    expect(restored.activeMessages.map((m) => m.content)).toEqual(['after']);
    expect(restored.latestSeq).toBe(3);
  });
});
