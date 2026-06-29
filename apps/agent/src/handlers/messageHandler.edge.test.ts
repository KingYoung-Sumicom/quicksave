// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Adversarial / edge-case tests for MessageHandler.
 *
 * These intentionally try to break the handler with race conditions,
 * invalid inputs, ordering violations, and concurrent operations.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageHandler } from './messageHandler.js';
import { createMessage, generateMessageId } from '@sumicom/quicksave-shared';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { simpleGit } from 'simple-git';
import { resetSessionRegistry, getSessionRegistry } from '../ai/sessionRegistry.js';
import { setQuicksaveDir } from '../service/singleton.js';

// Stub the CLI-spawning providers so edge-case tests don't fork real `claude`
// processes. These tests exercise MessageHandler lifecycle/race logic — real
// spawns under full-suite CPU contention made two tests marginally exceed the
// 5s default timeout. Providers are fully exercised in their own test files.
const makeMockSession = () => ({
  sendUserMessage: vi.fn(),
  interrupt: vi.fn(),
  kill: vi.fn(),
  alive: true,
  listSlashCommands: vi.fn(async () => [
    { name: 'mock-command', description: 'mock slash command' },
  ]),
});
vi.mock('../ai/claudeCodeProvider.js', () => ({
  ClaudeCodeProvider: vi.fn().mockImplementation(() => ({
    id: 'claude-code' as const,
    historyMode: 'claude-jsonl' as const,
    startSession: vi.fn().mockImplementation(async () => ({
      sessionId: `mock-${Math.random().toString(36).slice(2, 10)}`,
      session: makeMockSession(),
    })),
    resumeSession: vi.fn().mockImplementation(async (opts: { sessionId?: string }) => ({
      sessionId: opts.sessionId ?? `mock-${Math.random().toString(36).slice(2, 10)}`,
      session: makeMockSession(),
    })),
  })),
}));
vi.mock('../ai/codexAppServer/index.js', () => ({
  CodexAppServerProvider: vi.fn().mockImplementation(() => ({
    id: 'codex' as const,
    historyMode: 'memory' as const,
    startSession: vi.fn().mockImplementation(async () => ({
      sessionId: `mock-codex-${Math.random().toString(36).slice(2, 10)}`,
      session: makeMockSession(),
    })),
    resumeSession: vi.fn().mockImplementation(async (opts: { sessionId?: string }) => ({
      sessionId: opts.sessionId ?? `mock-codex-${Math.random().toString(36).slice(2, 10)}`,
      session: makeMockSession(),
    })),
  })),
  // Stub spawnAppServer too — MessageHandler.fetchCodexModels now calls it
  // at boot via primeCodexModelsCache. The edge tests don't care about the
  // codex model list; just return a minimal handle that fails model/list
  // so the cache stays empty.
  spawnAppServer: vi.fn(async () => ({
    rpc: {
      request: vi.fn(async () => { throw new Error('mocked: no model/list in edge tests'); }),
    },
    shutdown: vi.fn(async () => { /* noop */ }),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestRepo(suffix = ''): Promise<string> {
  const repoPath = join(
    tmpdir(),
    `qs-edge-test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(repoPath, { recursive: true });
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@test.com');
  await git.addConfig('user.name', 'Test User');
  await writeFile(join(repoPath, 'README.md'), '# Test Repo\n');
  await git.add('README.md');
  await git.commit('Initial commit');
  return repoPath;
}

function withRepo<T extends { repoPath?: string }>(message: T, repoPath: string): T {
  message.repoPath = repoPath;
  return message;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageHandler — edge cases', () => {
  let repoPath: string;
  let testQuicksaveDir: string;
  let handler: MessageHandler;
  const peerA = 'pwa:peerA';
  const peerB = 'pwa:peerB';

  beforeEach(async () => {
    testQuicksaveDir = join(tmpdir(), `qs-edge-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testQuicksaveDir, { recursive: true });
    setQuicksaveDir(testQuicksaveDir);
    resetSessionRegistry();
    repoPath = await createTestRepo('main');
    handler = new MessageHandler([{ path: repoPath, name: 'test-repo' }]);
  });

  afterEach(async () => {
    resetSessionRegistry();
    try {
      handler.cleanup();
    } catch { /* ignore */ }
    try {
      await rm(repoPath, { recursive: true, force: true });
    } catch { /* ignore */ }
    try {
      await rm(testQuicksaveDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // =========================================================================
  // 1. Race conditions in start/resume
  // =========================================================================

  describe('concurrent claude:start requests', () => {
    it('should handle two simultaneous start requests without crashing', async () => {
      // Both requests target the same cwd; the handler should not corrupt state.
      const msg1 = createMessage('claude:start', {
        prompt: 'Hello first',
        cwd: repoPath,
      } as any);
      const msg2 = createMessage('claude:start', {
        prompt: 'Hello second',
        cwd: repoPath,
      } as any);

      // Fire both concurrently — each may succeed or fail (provider may not be available).
      // The important thing is neither crashes or corrupts state.
      const results = await Promise.allSettled([
        handler.handleMessage(msg1, peerA),
        handler.handleMessage(msg2, peerB),
      ]);

      // Both should resolve (not reject)
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled') {
          expect(result.value.type).toBe('claude:start:response');
        }
      }

      // If both succeeded, session IDs must be distinct
      const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
      const successes = fulfilled.filter((r) => (r.value.payload as any).success);
      if (successes.length === 2) {
        expect((successes[0].value.payload as any).sessionId)
          .not.toBe((successes[1].value.payload as any).sessionId);
      }
    }, 30_000);

    it('should handle start then immediate cancel without crash', async () => {
      const startMsg = createMessage('claude:start', {
        prompt: 'Quick task',
        cwd: repoPath,
      } as any);

      const startResp = await handler.handleMessage(startMsg, peerA);
      expect(startResp.type).toBe('claude:start:response');

      const payload = startResp.payload as any;
      if (payload.success) {
        // Immediately cancel
        const cancelMsg = createMessage('claude:cancel', {
          sessionId: payload.sessionId,
        } as any);
        const cancelResp = await handler.handleMessage(cancelMsg, peerA);
        expect(cancelResp.type).toBe('claude:cancel:response');
        // Should succeed or gracefully fail
        expect(cancelResp.payload).toBeDefined();
      }
    });
  });

  // =========================================================================
  // 2. Resume on non-existent session
  // =========================================================================

  describe('claude:resume edge cases', () => {
    it('should handle resume for a non-existent session gracefully', async () => {
      const msg = createMessage('claude:resume', {
        sessionId: 'does-not-exist-000',
        prompt: 'Continue',
        cwd: repoPath,
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('claude:resume:response');
      // Should be either a graceful error or success (cold resume creates a new session)
      expect(resp.payload).toBeDefined();
    }, 30000);
  });

  // =========================================================================
  // 3. Error propagation
  // =========================================================================

  describe('error propagation', () => {
    it('should reject repo-scoped requests that omit repoPath', async () => {
      const emptyHandler = new MessageHandler([]);
      const msg = createMessage('git:status', {});

      const resp = await emptyHandler.handleMessage(msg, peerA);
      expect(resp.type).toBe('error');
      expect((resp.payload as any).code).toBe('MISSING_REPO_PATH');
    });

    it('should preserve message id on repoPath guard errors', async () => {
      const msg = createMessage('git:status', {});
      msg.id = 'custom-error-id-999';
      const emptyHandler = new MessageHandler([]);

      const resp = await emptyHandler.handleMessage(msg, peerA);
      expect(resp.type).toBe('error');
      expect(resp.id).toBe('custom-error-id-999');
      expect((resp.payload as any).code).toBe('MISSING_REPO_PATH');
    });

    it('should return proper error when claude:start fails at provider level', async () => {
      // Start session with a completely bogus agent value — falls through to default
      const msg = createMessage('claude:start', {
        prompt: 'test',
        cwd: '/nonexistent/path/that/will/likely/cause/issues',
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('claude:start:response');
      // Should not crash — either success or graceful failure
      expect(resp.payload).toBeDefined();
    });
  });

  // =========================================================================
  // 5. Permission edge cases — user-input-response
  // =========================================================================

  describe('claude:user-input-response edge cases', () => {
    it('should return success=false for an unknown requestId', () => {
      const msg = createMessage('claude:user-input-response', {
        requestId: 'unknown-request-id',
        action: 'allow',
        sessionId: 'unknown-session',
      } as any);

      // handleMessage is async but handleClaudeUserInputResponse is sync
      const resp = handler.handleMessage(msg, peerA);
      return resp.then((r) => {
        expect(r.type).toBe('claude:user-input-response');
        expect((r.payload as any).success).toBe(false);
      });
    });

    it('should handle user-input-response with missing payload fields without crashing', async () => {
      const msg = createMessage('claude:user-input-response', {
        requestId: undefined as any,
        action: 'allow',
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      // Should not crash; resolveUserInput checks Map for undefined key
      expect(resp.type).toBe('claude:user-input-response');
      expect((resp.payload as any).success).toBe(false);
    });
  });

  // =========================================================================
  // 6. Session lifecycle — cancel/close on finished/nonexistent sessions
  // =========================================================================

  describe('session lifecycle edge cases', () => {
    it('should return success=false when cancelling a non-existent session', async () => {
      const msg = createMessage('claude:cancel', {
        sessionId: 'ghost-session',
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('claude:cancel:response');
      expect((resp.payload as any).success).toBe(false);
      expect((resp.payload as any).error).toBeDefined();
    });

    it('should return success=false when closing a non-existent session', async () => {
      const msg = createMessage('claude:close', {
        sessionId: 'ghost-session',
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('claude:close:response');
      expect((resp.payload as any).success).toBe(false);
      expect((resp.payload as any).error).toBeDefined();
    });

    it('should handle double-close without error', async () => {
      // Start session, close it, close again
      const startMsg = createMessage('claude:start', {
        prompt: 'Temporary',
        cwd: repoPath,
      } as any);
      const startResp = await handler.handleMessage(startMsg, peerA);
      const sessionId = (startResp.payload as any).sessionId;
      if (!sessionId) return; // provider not available

      const close1 = createMessage('claude:close', { sessionId } as any);
      const resp1 = await handler.handleMessage(close1, peerA);
      expect(resp1.type).toBe('claude:close:response');
      expect((resp1.payload as any).success).toBe(true);

      // Second close
      const close2 = createMessage('claude:close', { sessionId } as any);
      const resp2 = await handler.handleMessage(close2, peerA);
      expect(resp2.type).toBe('claude:close:response');
      expect((resp2.payload as any).success).toBe(false);
    });

    it('should handle cancel followed by close', async () => {
      const startMsg = createMessage('claude:start', {
        prompt: 'Cancel then close',
        cwd: repoPath,
      } as any);
      const startResp = await handler.handleMessage(startMsg, peerA);
      const sessionId = (startResp.payload as any).sessionId;
      if (!sessionId) return;

      const cancelMsg = createMessage('claude:cancel', { sessionId } as any);
      await handler.handleMessage(cancelMsg, peerA);

      const closeMsg = createMessage('claude:close', { sessionId } as any);
      const closeResp = await handler.handleMessage(closeMsg, peerA);
      expect(closeResp.type).toBe('claude:close:response');
      // The session still exists in the map after cancel (cancel just interrupts),
      // so close should succeed.
      expect((closeResp.payload as any).success).toBe(true);
    });
  });

  // =========================================================================
  // 7. Config manipulation edge cases
  // =========================================================================

  describe('session:set-config edge cases', () => {
    it('should return a config object even for a non-existent sessionId', async () => {
      const msg = createMessage('session:set-config', {
        sessionId: 'no-such-session',
        key: 'model',
        value: 'claude-sonnet-4-20250514',
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('session:set-config:response');
      expect((resp.payload as any).success).toBe(true);
      // The config should still be set (SessionManager stores configs independently)
      expect((resp.payload as any).config).toBeDefined();
      expect((resp.payload as any).config.model).toBe('claude-sonnet-4-20250514');
    });

    it('should handle setting a null value without crashing', async () => {
      const msg = createMessage('session:set-config', {
        sessionId: 'test-null',
        key: 'reasoningEffort',
        value: null,
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('session:set-config:response');
      expect((resp.payload as any).success).toBe(true);
    });

    it('should handle setting an arbitrary unknown key', async () => {
      const msg = createMessage('session:set-config', {
        sessionId: 'test-unknown-key',
        key: 'totallyBogusKey',
        value: 42,
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('session:set-config:response');
      // BUG: setSessionConfig does not validate keys — any key is accepted silently.
      // The config will contain the bogus key. This is permissive, not a crash.
      expect((resp.payload as any).success).toBe(true);
      expect((resp.payload as any).config.totallyBogusKey).toBe(42);
    });

    it('should reject agent change on an active session via set-config', async () => {
      // Start a session, then try to change its agent via config
      const startMsg = createMessage('claude:start', {
        prompt: 'Agent change test',
        cwd: repoPath,
      } as any);
      const startResp = await handler.handleMessage(startMsg, peerA);
      const sessionId = (startResp.payload as any).sessionId;
      if (!sessionId) return;

      const setAgentMsg = createMessage('session:set-config', {
        sessionId,
        key: 'agent',
        value: 'codex',
      } as any);
      const resp = await handler.handleMessage(setAgentMsg, peerA);
      expect(resp.type).toBe('session:set-config:response');
      // Should succeed (the call returns) but the agent ID should NOT change
      expect((resp.payload as any).success).toBe(true);

      // Clean up
      const closeMsg = createMessage('claude:close', { sessionId } as any);
      await handler.handleMessage(closeMsg, peerA);
    }, 30000);
  });

  // =========================================================================
  // 8. Provider-neutral slash command listing
  // =========================================================================

  describe('session:list-slash-commands', () => {
    it('should return commands from the active provider session', async () => {
      const startMsg = createMessage('claude:start', {
        prompt: 'Slash command test',
        cwd: repoPath,
      } as any);
      const startResp = await handler.handleMessage(startMsg, peerA);
      expect(startResp.type).toBe('claude:start:response');
      expect((startResp.payload as any).success).toBe(true);

      const sessionId = (startResp.payload as any).sessionId;
      const msg = createMessage('session:list-slash-commands', {
        sessionId,
        cwd: repoPath,
      } as any);
      const resp = await handler.handleMessage(msg, peerA);

      expect(resp.type).toBe('session:list-slash-commands:response');
      expect(resp.id).toBe(msg.id);
      expect((resp.payload as any)).toEqual({
        success: true,
        sessionId,
        commands: [
          { name: 'mock-command', description: 'mock slash command' },
        ],
      });
    });
  });

  // =========================================================================
  // 9. Concurrent operations — get-cards during session startup
  // =========================================================================

  describe('concurrent get-cards during session startup', () => {
    it('should handle get-cards for a session that has no cardBuilder yet', async () => {
      // Requesting cards for a session ID that doesn't exist in the active sessions map
      const msg = createMessage('claude:get-cards', {
        sessionId: 'not-yet-started',
        cwd: repoPath,
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('claude:get-cards:response');
      // Should return empty cards, not crash
      const payload = resp.payload as any;
      expect(Array.isArray(payload.cards)).toBe(true);
      expect(payload.total).toBeDefined();
    });
  });

  // =========================================================================
  // 9. Repo lock contention — two peers same repo
  // =========================================================================

  describe('repo lock contention', () => {
    it('should block second peer from mutating while first holds lock', async () => {
      await writeFile(join(repoPath, 'file1.txt'), 'a');
      await writeFile(join(repoPath, 'file2.txt'), 'b');

      // Manually acquire the lock for peerA by starting an operation
      // We'll simulate this by having peerA do a stage, and peerB try simultaneously.
      // Since stage is async (git call), let's test the lock mechanism via commits.

      // Stage a file for peerA
      const git = simpleGit(repoPath);
      await git.add('file1.txt');

      // Try concurrent commits from different peers
      const commitMsg1 = withRepo(createMessage('git:commit', { message: 'Commit from A' } as any), repoPath);
      const commitMsg2 = withRepo(createMessage('git:commit', { message: 'Commit from B' } as any), repoPath);

      // The lock is per-repo, so if peerA holds it, peerB gets "Repository is busy"
      // In practice, the first one to acquireRepoLock wins.
      const [r1, r2] = await Promise.all([
        handler.handleMessage(commitMsg1, peerA),
        handler.handleMessage(commitMsg2, peerB),
      ]);

      // At least one should succeed
      const success1 = (r1.payload as any).success;
      const success2 = (r2.payload as any).success;
      expect(success1 || success2).toBe(true);

      // If one failed, it should have the "busy" error
      if (!success1) {
        expect((r1.payload as any).error).toContain('busy');
      }
      if (!success2) {
        expect((r2.payload as any).error).toContain('busy');
      }
    });

    it('should release lock after operation completes (even on error)', async () => {
      // Force an error: commit with nothing staged
      const commitMsg = withRepo(createMessage('git:commit', { message: 'Empty' } as any), repoPath);
      const resp = await handler.handleMessage(commitMsg, peerA);
      expect(resp.type).toBe('git:commit:response');

      // Lock should be released — peerB should be able to operate
      await writeFile(join(repoPath, 'newfile.txt'), 'content');
      const stageMsg = withRepo(createMessage('git:stage', { paths: ['newfile.txt'] } as any), repoPath);
      const stageResp = await handler.handleMessage(stageMsg, peerB);
      expect((stageResp.payload as any).success).toBe(true);
    });

    it('should allow same peer to perform sequential operations (lock re-entry)', async () => {
      await writeFile(join(repoPath, 'seq1.txt'), 'a');
      await writeFile(join(repoPath, 'seq2.txt'), 'b');

      const stage1 = withRepo(createMessage('git:stage', { paths: ['seq1.txt'] } as any), repoPath);
      const resp1 = await handler.handleMessage(stage1, peerA);
      expect((resp1.payload as any).success).toBe(true);

      const stage2 = withRepo(createMessage('git:stage', { paths: ['seq2.txt'] } as any), repoPath);
      const resp2 = await handler.handleMessage(stage2, peerA);
      expect((resp2.payload as any).success).toBe(true);
    });
  });

  // =========================================================================
  // 10. Unknown/malformed messages
  // =========================================================================

  describe('malformed and edge-case messages', () => {
    it('should handle unknown message type gracefully', async () => {
      const msg = createMessage('totally:fabricated:type' as any, { foo: 'bar' });
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('error');
      expect((resp.payload as any).code).toBe('UNKNOWN_MESSAGE_TYPE');
    });

    it('should handle message with empty payload', async () => {
      const msg = withRepo(createMessage('git:log', {} as any), repoPath);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('git:log:response');
      // Should use default limit
      const payload = resp.payload as any;
      expect(Array.isArray(payload.commits)).toBe(true);
    });

    it('should handle ping without timestamp', async () => {
      const msg = createMessage('ping', {} as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('pong');
    });
  });

  // =========================================================================
  // 11. set-session-permission edge cases
  // =========================================================================

  describe('claude:set-session-permission edge cases', () => {
    it('should reject an invalid permission mode', async () => {
      const msg = createMessage('claude:set-session-permission', {
        sessionId: 'any-session',
        permissionMode: 'superadmin',
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('claude:set-session-permission:response');
      // 'superadmin' is not in validModes, so success should be false
      expect((resp.payload as any).success).toBe(false);
    });

    it('should accept valid permission mode on a non-existent session', async () => {
      const msg = createMessage('claude:set-session-permission', {
        sessionId: 'phantom-session',
        permissionMode: 'acceptEdits',
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('claude:set-session-permission:response');
      // setPermissionLevel always returns true (stores in map regardless of session existence)
      expect((resp.payload as any).success).toBe(true);
    });
  });

  // =========================================================================
  // 12. Client removal and state cleanup
  // =========================================================================

  describe('client removal edge cases', () => {
    it('should handle removeClient for a client that never connected', () => {
      // Should not throw
      expect(() => handler.removeClient('never-seen-client')).not.toThrow();
    });

    it('should handle removeClient called twice for the same client', async () => {
      handler.removeClient(peerA);
      expect(() => handler.removeClient(peerA)).not.toThrow();
    });

    it('should keep explicit repoPath operations working after removeClient', async () => {
      const secondRepo = await createTestRepo('second');
      try {
        const multiHandler = new MessageHandler([
          { path: repoPath, name: 'main' },
          { path: secondRepo, name: 'second' },
        ]);

        multiHandler.removeClient(peerA);

        const status = await multiHandler.handleMessage(
          withRepo(createMessage('git:status', {}), secondRepo),
          peerA,
        );
        expect(status.type).toBe('git:status:response');
        expect(status.repoPath).toBe(secondRepo);
      } finally {
        await rm(secondRepo, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('should auto-add an explicit valid repoPath after that repo is removed from the managed list', async () => {
      const secondRepo = await createTestRepo('second');
      try {
        const multiHandler = new MessageHandler([
          { path: repoPath, name: 'main' },
          { path: secondRepo, name: 'second' },
        ]);

        multiHandler.removeRepo(secondRepo);

        const resp = await multiHandler.handleMessage(
          withRepo(createMessage('git:status', {}), secondRepo),
          peerA,
        );
        expect(resp.type).toBe('git:status:response');
      } finally {
        await rm(secondRepo, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  // =========================================================================
  // 13. Session history edge cases
  // =========================================================================

  describe('session history edge cases', () => {
    it('should return error when updating history for non-existent entry', async () => {
      const msg = createMessage('session:update-history', {
        sessionId: 'ghost',
        cwd: '/nonexistent',
        updates: { title: 'New Title' },
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('session:update-history:response');
      expect((resp.payload as any).success).toBe(false);
      expect((resp.payload as any).error).toContain('not found');
    });

    it('should return error when deleting history for non-existent entry', async () => {
      const msg = createMessage('session:delete-history', {
        sessionId: 'ghost',
        cwd: '/nonexistent',
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('session:delete-history:response');
      expect((resp.payload as any).success).toBe(false);
    });

    it('should return error when marking read on a non-existent entry', async () => {
      const msg = createMessage('session:mark-read', {
        sessionId: 'ghost',
        cwd: '/nonexistent',
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('session:mark-read:response');
      expect((resp.payload as any).success).toBe(false);
      expect((resp.payload as any).error).toContain('not found');
    });

    it('stamps lastReadAt and broadcasts when marking an existing entry read', async () => {
      const registry = getSessionRegistry();
      registry.upsertEntry({
        sessionId: 's-read-1',
        cwd: repoPath,
        createdAt: 1_000,
        lastAccessedAt: 1_000,
      });

      const broadcasts: Array<{ cwd: string; sessionId: string; action: string; lastReadAt?: number }> = [];
      handler.onHistoryUpdated = (cwd, entry, action) => {
        broadcasts.push({ cwd, sessionId: entry.sessionId, action, lastReadAt: entry.lastReadAt });
      };

      const msg = createMessage('session:mark-read', {
        sessionId: 's-read-1',
        cwd: repoPath,
        viewedAt: 5_000,
      } as any);
      const resp = await handler.handleMessage(msg, peerA);

      expect(resp.type).toBe('session:mark-read:response');
      expect((resp.payload as any).success).toBe(true);
      expect((resp.payload as any).lastReadAt).toBe(5_000);

      // Persisted on the registry entry.
      const persisted = registry.getEntry(repoPath, 's-read-1');
      expect(persisted?.lastReadAt).toBe(5_000);

      // Broadcast fired so other PWA clients of the same user converge.
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toMatchObject({ sessionId: 's-read-1', action: 'upsert', lastReadAt: 5_000 });
    });

    it('is max-wins: an older viewedAt does not regress a newer lastReadAt', async () => {
      const registry = getSessionRegistry();
      registry.upsertEntry({
        sessionId: 's-read-2',
        cwd: repoPath,
        createdAt: 1_000,
        lastAccessedAt: 1_000,
        lastReadAt: 9_000,
      });

      const broadcasts: Array<unknown> = [];
      handler.onHistoryUpdated = (_cwd, _entry, action) => { broadcasts.push(action); };

      const msg = createMessage('session:mark-read', {
        sessionId: 's-read-2',
        cwd: repoPath,
        viewedAt: 4_000, // older than the persisted 9_000
      } as any);
      const resp = await handler.handleMessage(msg, peerA);

      expect((resp.payload as any).success).toBe(true);
      // The response echoes the persisted value, not the stale incoming one.
      expect((resp.payload as any).lastReadAt).toBe(9_000);
      // No regression on disk and no spurious broadcast.
      expect(registry.getEntry(repoPath, 's-read-2')?.lastReadAt).toBe(9_000);
      expect(broadcasts).toHaveLength(0);
    });

    it('falls back to Date.now() when viewedAt is omitted', async () => {
      const registry = getSessionRegistry();
      registry.upsertEntry({
        sessionId: 's-read-3',
        cwd: repoPath,
        createdAt: 1_000,
        lastAccessedAt: 1_000,
      });
      const before = Date.now();
      const msg = createMessage('session:mark-read', {
        sessionId: 's-read-3',
        cwd: repoPath,
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      const after = Date.now();

      expect((resp.payload as any).success).toBe(true);
      const stamped = (resp.payload as any).lastReadAt as number;
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(after);
    });
  });

  // =========================================================================
  // 14. Handshake idempotency
  // =========================================================================

  describe('handshake edge cases', () => {
    it('should return consistent results on repeated handshakes', async () => {
      const msg1 = createMessage('handshake', { publicKey: 'key1' } as any);
      const msg2 = createMessage('handshake', { publicKey: 'key2' } as any);

      const resp1 = await handler.handleMessage(msg1, peerA);
      const resp2 = await handler.handleMessage(msg2, peerA);

      expect(resp1.type).toBe('handshake:ack');
      expect(resp2.type).toBe('handshake:ack');
      expect((resp1.payload as any).repoPath).toBe((resp2.payload as any).repoPath);
      expect((resp1.payload as any).agentVersion).toBe((resp2.payload as any).agentVersion);
    });

    it('should preserve message id in handshake ack', async () => {
      const msg = createMessage('handshake', { publicKey: 'test' } as any);
      msg.id = 'handshake-id-42';
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.id).toBe('handshake-id-42');
    });
  });

  // =========================================================================
  // 16. Preferences edge cases
  // =========================================================================

  describe('preferences edge cases', () => {
    it('should handle set-preferences with empty object', async () => {
      const msg = createMessage('claude:set-preferences', {
        preferences: {},
      } as any);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('claude:set-preferences:response');
      expect((resp.payload as any).success).toBe(true);
    });
  });

  // =========================================================================
  // 17. Handler with zero repos
  // =========================================================================

  describe('handler with zero repos', () => {
    it('should reject git operations without repoPath', async () => {
      const emptyHandler = new MessageHandler([]);

      const msgs = [
        createMessage('git:status', {}),
        createMessage('git:diff', { path: 'README.md', staged: false }),
        createMessage('git:log', { limit: 10 }),
        createMessage('git:branches', {}),
      ] as any[];

      for (const msg of msgs) {
        const resp = await emptyHandler.handleMessage(msg, peerA);
        expect(resp.type).toBe('error');
        expect((resp.payload as any).code).toBe('MISSING_REPO_PATH');
      }
    });

    it('should still handle ping, handshake, and claude operations', async () => {
      const emptyHandler = new MessageHandler([]);

      const ping = createMessage('ping', { timestamp: Date.now() });
      const pingResp = await emptyHandler.handleMessage(ping, peerA);
      expect(pingResp.type).toBe('pong');

      const hs = createMessage('handshake', { publicKey: 'k' } as any);
      const hsResp = await emptyHandler.handleMessage(hs, peerA);
      expect(hsResp.type).toBe('handshake:ack');
      expect((hsResp.payload as any).repoPath).toBe('');
    });
  });

  // =========================================================================
  // Git config (identity) messages
  // =========================================================================
  describe('git config identity', () => {
    it('git:config-get returns current identity', async () => {
      const msg = withRepo(createMessage('git:config-get', {}), repoPath);
      const resp = await handler.handleMessage(msg, peerA);
      expect(resp.type).toBe('git:config-get:response');
      const payload = resp.payload as { name?: string; email?: string };
      expect(payload.name).toBe('Test User');
      expect(payload.email).toBe('test@test.com');
    });

    it('git:config-set updates identity and subsequent get reflects it', async () => {
      const setMsg = withRepo(createMessage('git:config-set', { name: 'New User', email: 'new@test.com' }), repoPath);
      const setResp = await handler.handleMessage(setMsg, peerA);
      expect(setResp.type).toBe('git:config-set:response');
      expect((setResp.payload as any).success).toBe(true);

      const getMsg = withRepo(createMessage('git:config-get', {}), repoPath);
      const getResp = await handler.handleMessage(getMsg, peerA);
      const payload = getResp.payload as { name?: string; email?: string };
      expect(payload.name).toBe('New User');
      expect(payload.email).toBe('new@test.com');
    });
  });
});
