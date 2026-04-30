// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Tests for the Codex models cache + validation behavior on MessageHandler.
 *
 * Public surface exercised:
 *   - constructor(options.codexCacheDir)
 *   - primeCodexModelsCache
 *   - getCachedCodexModels
 *   - setCodexModelsUpdateHandler
 *   - validateCodexModel
 *   - handleMessage('codex:list-models')
 *
 * `spawnAppServer` is mocked so no real codex process is forked. Tests
 * drive the model list through that mock to cover: cache prime, hidden
 * filter, broadcast on change, validation/coercion of unsupported models.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageHandler } from './messageHandler.js';
import { createMessage } from '@sumicom/quicksave-shared';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { simpleGit } from 'simple-git';
import { resetSessionRegistry } from '../ai/sessionRegistry.js';
import { setQuicksaveDir } from '../service/singleton.js';

// Stub the CLI-spawning providers so these tests don't fork real CLIs.
const makeMockSession = () => ({
  sendUserMessage: vi.fn(),
  interrupt: vi.fn(),
  kill: vi.fn(),
  alive: true,
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
vi.mock('../ai/codexAppServer/index.js', async () => {
  // Keep the spawnAppServer named export but stub it. The test then sets
  // `nextModelListResponse` per-test; the stub returns that on
  // `model/list`. Provider is also stubbed so SessionManager wiring is
  // a no-op.
  return {
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
    spawnAppServer: vi.fn(async () => {
      const response = nextModelListResponse;
      const failureSpec = nextModelListFailure;
      return {
        rpc: {
          request: vi.fn(async (method: string) => {
            if (method !== 'model/list') {
              throw new Error(`unexpected rpc method ${method}`);
            }
            if (failureSpec) throw new Error(failureSpec);
            return response;
          }),
        },
        shutdown: vi.fn(async () => { /* noop */ }),
      };
    }),
  };
});

// Per-test fixtures consumed by the spawnAppServer mock above.
type ModelListResponse = {
  data: Array<{
    id: string;
    model: string;
    displayName: string;
    description: string;
    hidden: boolean;
    supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
    defaultReasoningEffort: string;
    inputModalities: string[];
    supportsPersonality: boolean;
    additionalSpeedTiers: string[];
    isDefault: boolean;
    upgrade: string | null;
    upgradeInfo: null;
    availabilityNux: null;
  }>;
  nextCursor: string | null;
};
let nextModelListResponse: ModelListResponse = { data: [], nextCursor: null };
let nextModelListFailure: string | null = null;

function modelEntry(opts: {
  id: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: string[];
}) {
  return {
    id: opts.id,
    model: opts.id,
    displayName: opts.displayName ?? opts.id,
    description: '',
    hidden: opts.hidden ?? false,
    supportedReasoningEfforts: (opts.supportedReasoningEfforts ?? []).map((e) => ({
      reasoningEffort: e,
      description: '',
    })),
    defaultReasoningEffort: opts.defaultReasoningEffort ?? 'medium',
    inputModalities: [],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    isDefault: opts.isDefault ?? false,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestRepo(suffix = ''): Promise<string> {
  const repoPath = join(
    tmpdir(),
    `qs-codex-models-repo-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(repoPath, { recursive: true });
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@test.com');
  await git.addConfig('user.name', 'Test User');
  return repoPath;
}

function uniqueDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageHandler — Codex models (model/list source)', () => {
  let repoPath: string;
  let testQuicksaveDir: string;
  let codexCacheDir: string;
  let handler: MessageHandler | null = null;
  const peerA = 'pwa:peerA';

  beforeEach(async () => {
    testQuicksaveDir = uniqueDir('qs-codex-models-home');
    await mkdir(testQuicksaveDir, { recursive: true });
    setQuicksaveDir(testQuicksaveDir);
    resetSessionRegistry();
    repoPath = await createTestRepo('main');
    codexCacheDir = uniqueDir('qs-codex-models');
    handler = null;
    nextModelListResponse = { data: [], nextCursor: null };
    nextModelListFailure = null;
  });

  afterEach(async () => {
    resetSessionRegistry();
    if (handler) {
      try { handler.cleanup(); } catch { /* ignore */ }
      handler = null;
    }
    try { await rm(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { await rm(testQuicksaveDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { await rm(codexCacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // 1. primeCodexModelsCache populates from model/list
  // -------------------------------------------------------------------------
  it('primeCodexModelsCache populates from model/list', async () => {
    nextModelListResponse = {
      data: [
        modelEntry({ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }),
        modelEntry({ id: 'gpt-5.4', displayName: 'GPT-5.4' }),
      ],
      nextCursor: null,
    };
    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir },
    );
    handler.primeCodexModelsCache();
    await sleep(20);
    expect(handler.getCachedCodexModels()).toEqual([
      { id: 'gpt-5.5', name: 'GPT-5.5', isDefault: true, defaultReasoningEffort: 'medium' },
      { id: 'gpt-5.4', name: 'GPT-5.4', defaultReasoningEffort: 'medium' },
    ]);
  });

  // -------------------------------------------------------------------------
  // 2. Hidden models filtered out (matches the old visibility filter intent)
  // -------------------------------------------------------------------------
  it('filters out hidden models', async () => {
    nextModelListResponse = {
      data: [
        modelEntry({ id: 'gpt-5.5', isDefault: true }),
        modelEntry({ id: 'codex-auto-review', hidden: true }),
      ],
      nextCursor: null,
    };
    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir },
    );
    handler.primeCodexModelsCache();
    await sleep(20);
    const ids = handler.getCachedCodexModels().map((m) => m.id);
    expect(ids).toEqual(['gpt-5.5']);
  });

  // -------------------------------------------------------------------------
  // 3. update handler fires when refresh changes the list
  // -------------------------------------------------------------------------
  it('fires update handler when a refresh returns a new list', async () => {
    nextModelListResponse = {
      data: [modelEntry({ id: 'gpt-5.4', isDefault: true })],
      nextCursor: null,
    };
    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir },
    );
    handler.primeCodexModelsCache();
    await sleep(20);
    const updateHandler = vi.fn();
    handler.setCodexModelsUpdateHandler(updateHandler);
    // Simulate a refresh: change the mocked list, force-fetch via the
    // private method through the public list-models handler with force=true
    // semantics (the handler's TTL is 30 min, so we trigger by direct call).
    nextModelListResponse = {
      data: [
        modelEntry({ id: 'gpt-5.4', isDefault: false }),
        modelEntry({ id: 'gpt-5.5', isDefault: true }),
      ],
      nextCursor: null,
    };
    // The only public force-refresh path is via the codex:list-models verb
    // when the cache is fresh. Force the TTL to bypass by manipulating
    // checkedAt to long ago.
    (handler as unknown as { codexModelsCache: { checkedAt: number } }).codexModelsCache.checkedAt = 0;
    const msg = createMessage('codex:list-models', {} as never);
    await handler.handleMessage(msg, peerA);
    expect(updateHandler).toHaveBeenCalledTimes(1);
    expect((updateHandler.mock.calls[0][0] as Array<{ id: string }>).map((m) => m.id))
      .toEqual(['gpt-5.4', 'gpt-5.5']);
  });

  // -------------------------------------------------------------------------
  // 4. update handler does NOT fire when refresh returns identical list
  // -------------------------------------------------------------------------
  it('does not fire update handler when content is unchanged', async () => {
    nextModelListResponse = {
      data: [modelEntry({ id: 'gpt-5.5', isDefault: true })],
      nextCursor: null,
    };
    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir },
    );
    handler.primeCodexModelsCache();
    await sleep(20);
    const updateHandler = vi.fn();
    handler.setCodexModelsUpdateHandler(updateHandler);
    // Force a refresh; same content comes back.
    (handler as unknown as { codexModelsCache: { checkedAt: number } }).codexModelsCache.checkedAt = 0;
    const msg = createMessage('codex:list-models', {} as never);
    await handler.handleMessage(msg, peerA);
    expect(updateHandler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. spawn failure leaves the cache empty without throwing
  // -------------------------------------------------------------------------
  it('does not throw when spawnAppServer or model/list fails; cache stays empty', async () => {
    nextModelListFailure = 'simulated spawn failure';
    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir },
    );
    expect(() => handler!.primeCodexModelsCache()).not.toThrow();
    await sleep(20);
    expect(handler.getCachedCodexModels()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 6. codex:list-models response surfaces the cache
  // -------------------------------------------------------------------------
  it('codex:list-models surfaces the cache', async () => {
    nextModelListResponse = {
      data: [modelEntry({ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true })],
      nextCursor: null,
    };
    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir },
    );
    handler.primeCodexModelsCache();
    await sleep(20);
    const msg = createMessage('codex:list-models', {} as never);
    const resp = await handler.handleMessage(msg, peerA);
    expect(resp.type).toBe('codex:list-models:response');
    const payload = resp.payload as { models: Array<{ id: string; name: string; isDefault?: boolean }> };
    expect(payload.models).toHaveLength(1);
    expect(payload.models[0]).toMatchObject({ id: 'gpt-5.5', name: 'GPT-5.5', isDefault: true });
  });
});

describe('MessageHandler.validateCodexModel — coercion', () => {
  let repoPath: string;
  let handler: MessageHandler;
  const codexCacheDir = uniqueDir('qs-codex-validate');

  beforeEach(async () => {
    setQuicksaveDir(uniqueDir('qs-codex-validate-home'));
    resetSessionRegistry();
    repoPath = await createTestRepo('validate');
    nextModelListResponse = {
      data: [
        modelEntry({ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }),
        modelEntry({ id: 'gpt-5.4', displayName: 'GPT-5.4' }),
      ],
      nextCursor: null,
    };
    nextModelListFailure = null;
    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir },
    );
    handler.primeCodexModelsCache();
    await sleep(20);
  });

  afterEach(async () => {
    try { handler.cleanup(); } catch { /* ignore */ }
    try { await rm(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('passes through a model that exists in the cache', () => {
    expect(handler.validateCodexModel('gpt-5.4', 'codex')).toBe('gpt-5.4');
  });

  it('coerces an unsupported model to the cache default', () => {
    expect(handler.validateCodexModel('claude-opus-4-7', 'codex')).toBe('gpt-5.5');
  });

  it('coerces undefined to the cache default', () => {
    expect(handler.validateCodexModel(undefined, 'codex')).toBe('gpt-5.5');
  });

  it('passes through any model when agent is not codex', () => {
    expect(handler.validateCodexModel('claude-opus-4-7', 'claude-code')).toBe('claude-opus-4-7');
    expect(handler.validateCodexModel(undefined, 'claude-code')).toBeUndefined();
  });

  it('passes through when cache is empty (cannot validate)', async () => {
    // Replace the handler with one whose model/list call failed.
    try { handler.cleanup(); } catch { /* ignore */ }
    nextModelListFailure = 'no models available';
    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir },
    );
    handler.primeCodexModelsCache();
    await sleep(20);
    expect(handler.getCachedCodexModels()).toEqual([]);
    // Without a cache we'd rather try the user's choice than swallow it.
    expect(handler.validateCodexModel('claude-opus-4-7', 'codex')).toBe('claude-opus-4-7');
  });
});
