// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceConfig } from '@sumicom/quicksave-shared';
import { VoiceIntermediarySupervisor } from './supervisor.js';
import type { VoiceManagerBridge } from './manager.js';
import { VoiceDebugStore } from './debugStore.js';

function bridge(cwd: string): VoiceManagerBridge {
  return {
    getSessionCwd: () => cwd,
    isOpen: () => true,
    sendUserMessageToSession: () => true,
    interruptSession: async () => true,
    resolveUserInput: () => true,
    setPermissionLevel: async () => true,
    getCards: async () => ({ cards: [], total: 0, hasMore: false }),
    getPendingInputRequests: () => [],
    getPermissionLevel: () => 'default',
    getActiveSessions: () => [{ sessionId: 'session-worker-test' }],
    isStreaming: () => false,
  };
}

const config: VoiceConfig = {
  mode: 'batch',
  baseUrl: 'https://example.invalid/v1',
  apiKey: '',
  transcribeModel: 'test-stt',
  agentModel: 'test-brain',
  ttsModel: 'test-tts',
  ttsVoice: 'test-voice',
};

describe('VoiceIntermediarySupervisor', () => {
  it('reloads the worker with a new instance and restores attached sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quicksave-voice-supervisor-'));
    const previousHome = process.env.QUICKSAVE_HOME;
    process.env.QUICKSAVE_HOME = root;
    const supervisor = new VoiceIntermediarySupervisor(
      bridge(root),
      new VoiceDebugStore(join(root, 'voice-debug')),
    );

    try {
      const attached = await supervisor.attach('session-worker-test', config, 'page-a');
      expect(attached.active).toBe(true);
      expect(attached.traceHistory).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: 'worker.ready',
          data: expect.objectContaining({ model: config.agentModel }),
        }),
      ]));

      const first = await supervisor.reload();
      expect(first.state).toBe('ready');
      expect(first.buildId).toMatch(/^voice-[a-f0-9]{12}$/);
      expect(first.restoredSessionCount).toBe(1);
      expect(first.pid).toBeTypeOf('number');

      const second = await supervisor.reload();
      expect(second.state).toBe('ready');
      expect(second.buildId).toBe(first.buildId);
      expect(second.instanceId).not.toBe(first.instanceId);
      expect(second.restoredSessionCount).toBe(1);

      const reattached = await supervisor.attach('session-worker-test', config, 'page-b');
      expect(reattached.traceHistory.some((entry) =>
        entry.event === 'worker.reloading'
        && entry.data?.buildId === first.buildId,
      )).toBe(true);
      supervisor.detach('session-worker-test', 'page-a');
      expect(supervisor.isAttached('session-worker-test')).toBe(true);
      supervisor.detach('session-worker-test', 'page-b');
      expect(supervisor.isAttached('session-worker-test')).toBe(false);
      expect(reattached.traceHistory.some((entry) =>
        entry.event === 'worker.ready'
        && entry.data?.instanceId === second.instanceId,
      )).toBe(true);
    } finally {
      await supervisor.close();
      if (previousHome === undefined) delete process.env.QUICKSAVE_HOME;
      else process.env.QUICKSAVE_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
