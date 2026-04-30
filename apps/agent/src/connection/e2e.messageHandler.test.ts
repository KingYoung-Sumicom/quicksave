// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { simpleGit } from 'simple-git';
import {
  FakeRelayHub,
  FakeWebSocket,
  setActiveFakeRelayHub,
} from './fakeRelay.js';

/**
 * End-to-end test that pipes a real `MessageHandler` through the
 * `FakeRelayHub` + `AgentConnection` + `MessageBusServer` stack and drives
 * verbs from a `FakePwa` running a real `MessageBusClient`. The bus adapter
 * (`wireLegacyBusVerbs`) is the same one wired in `service/run.ts`, so this
 * exercises the verb-routing path the PWA actually uses.
 *
 * What's real:
 * - V2 key exchange + DEK encryption
 * - gzip + base64 + routed envelope framing on both sides
 * - `MessageHandler.handleMessage` switch (ping, git:*, agent:list-repos)
 * - `wireLegacyBusVerbs` adapter — the smuggled `__repoPath`, the error
 *   encoding, the response repoPath echo
 * - `simple-git` against a real temp repo
 *
 * What's mocked:
 * - `ws` module (replaced by FakeWebSocket)
 * - `tombstoneCheck` module (no-op so we don't hit relay HTTP)
 * - A few `config.ts` mutators (`addManagedRepo` etc.) so test runs don't
 *   touch the real `~/.quicksave/managed-repos`. `loadConfig`,
 *   `saveConfig`, `isPaired`, and `pinPeerPWA` stay real and are
 *   redirected to a per-test temp dir via `setQuicksaveDir`.
 */

vi.mock('ws', () => ({
  __esModule: true,
  default: FakeWebSocket,
  WebSocket: FakeWebSocket,
}));

vi.mock('../tombstoneCheck.js', () => ({
  checkTombstone: vi.fn().mockResolvedValue({ status: 'absent' }),
  hashPublicKey: vi.fn((pk: string) => `hash-${pk.slice(0, 12)}`),
  verifyTombstonePayload: vi.fn(),
}));

// Keep loadConfig / saveConfig / isPaired / pinPeerPWA real (they go
// through `setQuicksaveDir`); only stub the on-disk repo-list mutators
// the MessageHandler touches when it manages repos.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    addManagedRepo: vi.fn(),
    removeManagedRepo: vi.fn(),
    addManagedCodingPath: vi.fn(),
    removeManagedCodingPath: vi.fn(),
    getAnthropicApiKey: vi.fn(() => undefined),
    setAnthropicApiKey: vi.fn(),
    hasAnthropicApiKey: vi.fn(() => false),
  };
});

import { setQuicksaveDir } from '../service/singleton.js';
import { createDefaultConfig } from '../config.js';
import { resetSessionRegistry } from '../ai/sessionRegistry.js';
import { MessageHandler } from '../handlers/messageHandler.js';
import { wireLegacyBusVerbs } from '../handlers/legacyBusAdapter.js';
import { buildAgent, FakePwa, type AgentSide } from './e2eHarness.js';

describe('MessageHandler over the bus via FakeRelayHub', () => {
  let hub: FakeRelayHub;
  let agent: AgentSide;
  let pwa: FakePwa;
  let messageHandler: MessageHandler;
  let tempDir: string;
  let repoPath: string;
  let defaultBranch: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'qs-e2emh-'));
    setQuicksaveDir(tempDir);
    resetSessionRegistry();
    const config = createDefaultConfig('ws://test');

    // Real git repo with one commit so git:status / branches return.
    repoPath = mkdtempSync(join(tmpdir(), 'qs-repo-'));
    const git = simpleGit(repoPath);
    await git.init();
    await git.addConfig('user.email', 'test@test.com');
    await git.addConfig('user.name', 'Test User');
    writeFileSync(join(repoPath, 'README.md'), '# test\n');
    await git.add('README.md');
    await git.commit('initial');
    const status = await git.status();
    defaultBranch = status.current ?? 'main';

    hub = new FakeRelayHub();
    setActiveFakeRelayHub(hub);

    agent = buildAgent({
      agentId: config.agentId,
      agentKeyPair: config.keyPair,
    });

    messageHandler = new MessageHandler([
      { path: repoPath, name: 'test-repo' },
    ]);
    wireLegacyBusVerbs(agent.bus, messageHandler);

    await agent.start();
    pwa = new FakePwa({
      hub,
      agentId: agent.agentId,
      agentPublicKeyB64: agent.publicKeyB64,
    });
    await pwa.start();
  });

  afterEach(async () => {
    pwa?.close();
    agent?.stop();
    messageHandler?.cleanup();
    setActiveFakeRelayHub(null);
    hub?.close();
    resetSessionRegistry();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    try {
      rmSync(repoPath, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('ping verb returns pong with a timestamp', async () => {
    const result = await pwa.bus().command<
      { timestamp: number },
      { timestamp: number }
    >('ping', { timestamp: 0 });
    expect(typeof result.timestamp).toBe('number');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('agent:list-repos returns the registered repo + current branch', async () => {
    const result = await pwa.bus().command<unknown, {
      repos: Array<{ path: string; name: string; currentBranch?: string }>;
      current: string;
    }>('agent:list-repos', {});
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].path).toBe(repoPath);
    expect(result.repos[0].currentBranch).toBe(defaultBranch);
  });

  describe('git:* with __repoPath smuggling', () => {
    it('git:status against the matching repoPath echoes __repoPath back', async () => {
      const result = await pwa.bus().command<
        { __repoPath: string },
        {
          branch: string;
          staged: unknown[];
          unstaged: unknown[];
          __repoPath?: string;
        }
      >('git:status', { __repoPath: repoPath });
      expect(result.branch).toBe(defaultBranch);
      expect(Array.isArray(result.staged)).toBe(true);
      expect(Array.isArray(result.unstaged)).toBe(true);
      // The adapter mirrors the server's stamped repoPath into the response
      // payload so the PWA can scope-check.
      expect(result.__repoPath).toBe(repoPath);
    });

    it('git:status with a __repoPath the agent does not own rejects with REPO_MISMATCH', async () => {
      await expect(
        pwa.bus().command('git:status', { __repoPath: '/nope/does/not/exist' }),
      ).rejects.toThrow(/REPO_MISMATCH/);
    });
  });

  it('unknown verb rejects with the bus-default Unknown command error', async () => {
    // Verb is not in LEGACY_BUS_VERBS, so no handler is registered. The
    // bus server responds with `Unknown command: ...`.
    await expect(
      pwa.bus().command('does-not-exist', {}),
    ).rejects.toThrow(/Unknown command: does-not-exist/);
  });

  it('two PWAs (sharing a group sigKey) hit the same handler concurrently', async () => {
    // In prod, every PWA tab in a group derives from one Ed25519 identity,
    // so every handshake passes the TOFU check after the first pin. Reuse
    // the first PWA's signKeyPair on the second so the agent doesn't reject.
    const pwa2 = new FakePwa({
      hub,
      agentId: agent.agentId,
      agentPublicKeyB64: agent.publicKeyB64,
      signKeyPair: pwa.groupSignKeyPair(),
    });
    await pwa2.start();

    try {
      const [a, b] = await Promise.all([
        pwa.bus().command<unknown, { timestamp: number }>('ping', {}),
        pwa2.bus().command<unknown, { timestamp: number }>('ping', {}),
      ]);
      expect(typeof a.timestamp).toBe('number');
      expect(typeof b.timestamp).toBe('number');
    } finally {
      pwa2.close();
    }
  });
});
