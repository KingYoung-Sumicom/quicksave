// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Tests for the opencode:guardian-update / opencode:guardian-test IPC verbs.
 *
 * The probe is mocked so no real network call is made; the active guardian
 * config is driven through the QUICKSAVE_GUARDIAN_* environment variables,
 * exactly as `getGuardianModelServerConfig()` resolves it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { simpleGit } from 'simple-git';
import { createMessage } from '@sumicom/quicksave-shared';

const makeMockSession = () => ({
  sendUserMessage: vi.fn(), interrupt: vi.fn(), kill: vi.fn(), alive: true,
});
vi.mock('../ai/claudeCodeProvider.js', () => ({
  ClaudeCodeProvider: vi.fn().mockImplementation(() => ({
    id: 'claude-code', historyMode: 'claude-jsonl',
    startSession: vi.fn().mockResolvedValue({ sessionId: 'mock', session: makeMockSession() }),
    resumeSession: vi.fn().mockResolvedValue({ sessionId: 'mock', session: makeMockSession() }),
  })),
}));
vi.mock('../ai/codexAppServer/index.js', () => ({
  CodexAppServerProvider: vi.fn().mockImplementation(() => ({
    id: 'codex', historyMode: 'memory',
    startSession: vi.fn().mockResolvedValue({ sessionId: 'mock', session: makeMockSession() }),
    resumeSession: vi.fn().mockResolvedValue({ sessionId: 'mock', session: makeMockSession() }),
  })),
  spawnAppServer: vi.fn(async () => ({
    rpc: { request: vi.fn(async () => ({ data: [], nextCursor: null })) },
    shutdown: vi.fn(async () => { /* noop */ }),
  })),
}));
vi.mock('../ai/openCodeServer.js', () => ({
  getOpenCodeServer: vi.fn(() => ({
    getHealth: vi.fn(async () => ({ healthy: true, version: '1.18.8' })),
  })),
}));

const { probeSpy } = vi.hoisted(() => ({ probeSpy: vi.fn() }));
vi.mock('../ai/guardianModelClient.js', () => ({
  probeGuardianModel: probeSpy,
  callGuardianModel: vi.fn(),
}));

const { MessageHandler } = await import('./messageHandler.js');
const { resetSessionRegistry } = await import('../ai/sessionRegistry.js');
const { setQuicksaveDir } = await import('../service/singleton.js');
const { getGuardianModelServerConfig } = await import('../config.js');

function uniqueDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function createTestRepo(): Promise<string> {
  const repoPath = uniqueDir('qs-guardian-repo');
  await mkdir(repoPath, { recursive: true });
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@test.com');
  await git.addConfig('user.name', 'Test');
  return repoPath;
}

const ENV_KEYS = [
  'QUICKSAVE_GUARDIAN_MODEL_SERVER_URL',
  'QUICKSAVE_GUARDIAN_MODEL',
  'QUICKSAVE_GUARDIAN_MODEL_SERVER_API_KEY',
  'QUICKSAVE_GUARDIAN_ENABLE_THINKING',
  'QUICKSAVE_GUARDIAN_TIMEOUT_MS',
  'QUICKSAVE_GUARDIAN_MAX_CONSECUTIVE',
];

describe('MessageHandler — opencode:guardian-test', () => {
  let repoPath: string;
  let testHome: string;
  let handler: InstanceType<typeof MessageHandler> | null = null;

  beforeEach(async () => {
    testHome = uniqueDir('qs-guardian-home');
    await mkdir(testHome, { recursive: true });
    setQuicksaveDir(testHome);
    resetSessionRegistry();
    repoPath = await createTestRepo();
    for (const key of ENV_KEYS) delete process.env[key];
    probeSpy.mockReset();
    handler = new MessageHandler([{ path: repoPath, name: 'test-repo' }]);
  });

  afterEach(async () => {
    resetSessionRegistry();
    for (const key of ENV_KEYS) delete process.env[key];
    if (handler) {
      try { handler.cleanup(); } catch { /* ignore */ }
      handler = null;
    }
    try { await rm(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { await rm(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('rejects when the guardian is not configured and never probes', async () => {
    const req = createMessage('opencode:guardian-test', {});
    const res = await handler!.handleMessage(req);
    expect(res?.type).toBe('opencode:guardian-test:response');
    expect(res?.payload).toEqual({ success: false, configured: false, error: 'Guardian is not configured' });
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('rejects a draft that is missing one of the endpoint fields', async () => {
    process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL = 'http://review.example/v1';
    process.env.QUICKSAVE_GUARDIAN_MODEL = 'reviewer';
    const req = createMessage('opencode:guardian-test', { baseUrl: 'http://only-url.example/v1' });
    const res = await handler!.handleMessage(req);
    expect(res?.payload).toEqual({
      success: false, configured: false, error: 'Provide both base URL and model to test',
    });
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('probes the stored config and records daemon state when the draft matches it', async () => {
    process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL = 'http://review.example/v1';
    process.env.QUICKSAVE_GUARDIAN_MODEL = 'reviewer';
    probeSpy.mockResolvedValue({ ok: true, latencyMs: 42 });

    const req = createMessage('opencode:guardian-test', {});
    const res = await handler!.handleMessage(req);
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(probeSpy).toHaveBeenCalledWith(
      { baseUrl: 'http://review.example/v1', model: 'reviewer', enableThinking: false },
      30_000,
      true,
    );
    expect(res?.payload).toEqual({ success: true, configured: true, latencyMs: 42 });
  });

  it('probes a trailing-slash draft against the stored server without recording state', async () => {
    process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL = 'http://review.example/v1';
    process.env.QUICKSAVE_GUARDIAN_MODEL = 'reviewer';
    probeSpy.mockResolvedValue({ ok: true, latencyMs: 7 });

    const req = createMessage('opencode:guardian-test', {
      baseUrl: 'http://review.example/v1/', model: 'reviewer',
    });
    const res = await handler!.handleMessage(req);
    // Trailing slash stripped, so the draft IS the active config.
    expect(probeSpy).toHaveBeenCalledWith(
      { baseUrl: 'http://review.example/v1', model: 'reviewer', enableThinking: false },
      30_000,
      true,
    );
    expect(res?.payload).toEqual({ success: true, configured: true, latencyMs: 7 });
  });

  it('probes divergent draft values without touching the daemon-wide state', async () => {
    process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL = 'http://review.example/v1';
    process.env.QUICKSAVE_GUARDIAN_MODEL = 'reviewer';
    probeSpy.mockResolvedValue({ ok: false, error: 'guardian model server 500: boom', latencyMs: 10 });

    const req = createMessage('opencode:guardian-test', {
      baseUrl: 'http://draft.example/v1', model: 'draft-model',
    });
    const res = await handler!.handleMessage(req);
    expect(probeSpy).toHaveBeenCalledWith(
      { baseUrl: 'http://draft.example/v1', model: 'draft-model', enableThinking: false },
      30_000,
      false,
    );
    expect(res?.payload).toEqual({
      success: false, configured: true, error: 'guardian model server 500: boom',
    });
  });

  it('a draft API key forces a stateless probe even for the stored endpoint', async () => {
    process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL = 'http://review.example/v1';
    process.env.QUICKSAVE_GUARDIAN_MODEL = 'reviewer';
    process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_API_KEY = 'stored-key';
    probeSpy.mockResolvedValue({ ok: true, latencyMs: 3 });

    const req = createMessage('opencode:guardian-test', {
      baseUrl: 'http://review.example/v1', model: 'reviewer', apiKey: 'draft-key',
    });
    const res = await handler!.handleMessage(req);
    expect(probeSpy).toHaveBeenCalledWith(
      { baseUrl: 'http://review.example/v1', model: 'reviewer', apiKey: 'draft-key', enableThinking: false },
      30_000,
      false,
    );
    expect(res?.payload).toEqual({ success: true, configured: true, latencyMs: 3 });
  });

  it('surfaces probe transport errors as a failure', async () => {
    process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL = 'http://review.example/v1';
    process.env.QUICKSAVE_GUARDIAN_MODEL = 'reviewer';
    probeSpy.mockRejectedValue(new Error('boom'));

    const req = createMessage('opencode:guardian-test', {});
    const res = await handler!.handleMessage(req);
    expect(res?.payload).toEqual({ success: false, configured: false, error: 'boom' });
  });
});

describe('MessageHandler — opencode:guardian-update', () => {
  let repoPath: string;
  let testHome: string;
  let handler: InstanceType<typeof MessageHandler> | null = null;

  beforeEach(async () => {
    testHome = uniqueDir('qs-guardian-home');
    await mkdir(testHome, { recursive: true });
    setQuicksaveDir(testHome);
    resetSessionRegistry();
    repoPath = await createTestRepo();
    for (const key of ENV_KEYS) delete process.env[key];
    probeSpy.mockReset();
    handler = new MessageHandler([{ path: repoPath, name: 'test-repo' }]);
  });

  afterEach(async () => {
    resetSessionRegistry();
    for (const key of ENV_KEYS) delete process.env[key];
    if (handler) {
      try { handler.cleanup(); } catch { /* ignore */ }
      handler = null;
    }
    try { await rm(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { await rm(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('persists valid settings', async () => {
    const req = createMessage('opencode:guardian-update', {
      baseUrl: 'http://localhost:8000/v1/', model: 'reviewer', apiKey: 'secret',
      enableThinking: true, timeoutMs: 45_000, maxConsecutiveDenials: 4,
    });
    const res = await handler!.handleMessage(req);
    expect(res?.type).toBe('opencode:guardian-update:response');
    expect(res?.payload).toEqual({ success: true });
    expect(getGuardianModelServerConfig()).toEqual({
      baseUrl: 'http://localhost:8000/v1', model: 'reviewer', apiKey: 'secret', enableThinking: true,
    });
  });

  it('reports validation errors from the settings writer', async () => {
    const req = createMessage('opencode:guardian-update', {
      baseUrl: 'http://localhost:8000/v1', model: '',
      enableThinking: false, timeoutMs: 60_000, maxConsecutiveDenials: 3,
    });
    const res = await handler!.handleMessage(req);
    expect(res?.payload).toMatchObject({ success: false, error: expect.stringMatching(/both be set/i) });
  });
});
