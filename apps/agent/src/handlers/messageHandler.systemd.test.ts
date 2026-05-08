// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Tests for the three systemd:* IPC verbs on MessageHandler:
 *   - systemd:status
 *   - systemd:install
 *   - systemd:uninstall
 *
 * The systemdUnit module is mocked end-to-end so these tests don't shell out
 * to a real `systemctl` and don't touch the filesystem. We focus on the
 * routing / response shaping concerns that live in MessageHandler itself,
 * not on the install/uninstall mechanics (those are covered by
 * `service/systemdUnit.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { simpleGit } from 'simple-git';
import { createMessage, type SystemdStatusPayload } from '@sumicom/quicksave-shared';

// Stub providers so SessionManager wiring doesn't fork real CLIs.
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

// Mock the systemd helpers so we drive the handler responses without real I/O.
const baseStatus: SystemdStatusPayload = {
  available: true,
  unitInstalled: false,
  unitEnabled: false,
  isActive: false,
  lingerEnabled: false,
  unitDir: '/home/test/.config/systemd/user',
  unitPath: '/home/test/.config/systemd/user/quicksave.service',
  suggestedExecStart: '/usr/bin/node /opt/agent/index.js service run',
};
let mockStatus: SystemdStatusPayload = { ...baseStatus };
let mockSystemctlAvailable = true;
let mockInstallResult = { success: true as boolean, error: undefined as string | undefined, status: { ...baseStatus } };
let mockUninstallResult = { success: true as boolean, error: undefined as string | undefined, status: { ...baseStatus } };
const installSpy = vi.fn();
const uninstallSpy = vi.fn();

vi.mock('../service/systemdUnit.js', () => ({
  systemctlAvailable: vi.fn(() => mockSystemctlAvailable),
  getSystemdStatus: vi.fn(() => ({ ...mockStatus })),
  installUserUnit: vi.fn(() => {
    installSpy();
    return mockInstallResult;
  }),
  uninstallUserUnit: vi.fn(() => {
    uninstallSpy();
    return mockUninstallResult;
  }),
  // Other exports referenced by the rest of the file/route table — only the
  // names the handler imports need to exist.
}));

const { MessageHandler } = await import('./messageHandler.js');
const { resetSessionRegistry } = await import('../ai/sessionRegistry.js');
const { setQuicksaveDir } = await import('../service/singleton.js');

function uniqueDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function createTestRepo(): Promise<string> {
  const repoPath = uniqueDir('qs-systemd-repo');
  await mkdir(repoPath, { recursive: true });
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@test.com');
  await git.addConfig('user.name', 'Test');
  return repoPath;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('MessageHandler — systemd verbs', () => {
  let repoPath: string;
  let testHome: string;
  let handler: InstanceType<typeof MessageHandler> | null = null;

  beforeEach(async () => {
    testHome = uniqueDir('qs-systemd-home');
    await mkdir(testHome, { recursive: true });
    setQuicksaveDir(testHome);
    resetSessionRegistry();
    repoPath = await createTestRepo();
    mockStatus = { ...baseStatus };
    mockSystemctlAvailable = true;
    mockInstallResult = { success: true, error: undefined, status: { ...baseStatus } };
    mockUninstallResult = { success: true, error: undefined, status: { ...baseStatus } };
    installSpy.mockReset();
    uninstallSpy.mockReset();
    handler = new MessageHandler([{ path: repoPath, name: 'test-repo' }]);
  });

  afterEach(async () => {
    resetSessionRegistry();
    if (handler) {
      try { handler.cleanup(); } catch { /* ignore */ }
      handler = null;
    }
    try { await rm(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { await rm(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('systemd:status returns the current SystemdStatus snapshot', async () => {
    mockStatus = { ...baseStatus, unitInstalled: true, unitEnabled: true, isActive: true, lingerEnabled: true };
    const req = createMessage('systemd:status', {});
    const res = await handler!.handleMessage(req);
    expect(res?.type).toBe('systemd:status:response');
    expect(res?.id).toBe(req.id);
    expect(res?.payload).toMatchObject({
      available: true,
      unitInstalled: true,
      unitEnabled: true,
      isActive: true,
      lingerEnabled: true,
    });
  });

  it('systemd:install delegates to installUserUnit and returns its result', async () => {
    mockInstallResult = {
      success: true,
      error: undefined,
      status: { ...baseStatus, unitInstalled: true, unitEnabled: true, isActive: true },
    };
    const req = createMessage('systemd:install', {});
    const res = await handler!.handleMessage(req);
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(res?.type).toBe('systemd:install:response');
    expect(res?.id).toBe(req.id);
    expect(res?.payload).toMatchObject({
      success: true,
      status: { unitInstalled: true, unitEnabled: true, isActive: true },
    });
  });

  it('systemd:install short-circuits when systemctl is unavailable', async () => {
    mockSystemctlAvailable = false;
    const req = createMessage('systemd:install', {});
    const res = await handler!.handleMessage(req);
    expect(installSpy).not.toHaveBeenCalled();
    expect(res?.payload).toMatchObject({ success: false });
    expect((res?.payload as { error?: string }).error).toMatch(/systemctl/);
  });

  it('systemd:install propagates failure from the helper', async () => {
    mockInstallResult = {
      success: false,
      error: 'enable --now failed: no dbus',
      status: { ...baseStatus },
    };
    const req = createMessage('systemd:install', {});
    const res = await handler!.handleMessage(req);
    expect(res?.payload).toMatchObject({
      success: false,
      error: 'enable --now failed: no dbus',
    });
  });

  it('systemd:uninstall responds optimistically and defers the actual uninstall', async () => {
    mockStatus = { ...baseStatus, unitInstalled: true, unitEnabled: true, isActive: true };
    const req = createMessage('systemd:uninstall', {});
    const res = await handler!.handleMessage(req);
    // Response is sent BEFORE the helper runs (so the IPC socket survives
    // disable --now killing the daemon).
    expect(uninstallSpy).not.toHaveBeenCalled();
    expect(res?.type).toBe('systemd:uninstall:response');
    expect(res?.id).toBe(req.id);
    expect(res?.payload).toMatchObject({
      success: true,
      status: {
        unitInstalled: false,
        unitEnabled: false,
        isActive: false,
      },
    });
    expect((res?.payload as { status: SystemdStatusPayload }).status.currentExecStart).toBeUndefined();
    // After the next tick, the deferred uninstall runs.
    await sleep(20);
    expect(uninstallSpy).toHaveBeenCalledTimes(1);
  });

  it('systemd:uninstall short-circuits when systemctl is unavailable', async () => {
    mockSystemctlAvailable = false;
    const req = createMessage('systemd:uninstall', {});
    const res = await handler!.handleMessage(req);
    expect(res?.payload).toMatchObject({ success: false });
    await sleep(10);
    expect(uninstallSpy).not.toHaveBeenCalled();
  });
});
