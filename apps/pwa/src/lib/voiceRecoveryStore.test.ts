// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetVoiceRecoveryMemoryForTest,
  getVoiceRecoveryDraft,
  listVoiceRecoveryDrafts,
  removeVoiceRecoveryDraft,
  saveVoiceRecoveryDraft,
} from './voiceRecoveryStore';

describe('voiceRecoveryStore fallback', () => {
  beforeEach(() => {
    _resetVoiceRecoveryMemoryForTest();
    vi.stubGlobal('indexedDB', undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('retains Blob recordings per composer until the user discards them', async () => {
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/pcm' });
    await saveVoiceRecoveryDraft({
      id: 'draft-a',
      composerKey: 'session:one',
      kind: 'streaming-pcm',
      audio,
      sampleRate: 24_000,
      createdAt: 1,
      updatedAt: 1,
      error: 'network lost',
    });
    await saveVoiceRecoveryDraft({
      id: 'draft-b',
      composerKey: 'session:two',
      kind: 'batch-blob',
      audio: new Blob(['other']),
      createdAt: 2,
      updatedAt: 2,
    });

    expect(await listVoiceRecoveryDrafts('session:one')).toEqual([
      expect.objectContaining({ id: 'draft-a', bytes: 3, error: 'network lost' }),
    ]);
    expect((await getVoiceRecoveryDraft('draft-a'))?.audio).toBe(audio);

    await removeVoiceRecoveryDraft('draft-a');
    expect(await listVoiceRecoveryDrafts('session:one')).toEqual([]);
  });
});
