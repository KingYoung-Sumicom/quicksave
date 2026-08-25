// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAuthManager, parseClaudeAuthStatus } from './claudeAuth.js';

describe('ClaudeAuthManager', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it('uses ANTHROPIC_API_KEY without spawning Claude', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const manager = new ClaudeAuthManager(async () => {
      throw new Error('runner should not be called');
    });

    await expect(manager.getStatus()).resolves.toEqual({ loggedIn: true, method: 'api-key' });
  });

  it('returns a sanitized Claude CLI status', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const manager = new ClaudeAuthManager(async () => JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'pro',
      email: 'private@example.com',
      orgId: 'private-org',
    }));

    await expect(manager.getStatus()).resolves.toEqual({
      loggedIn: true,
      method: 'claude.ai',
      subscriptionType: 'pro',
    });
  });

  it('reports unavailable status without leaking command errors', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const manager = new ClaudeAuthManager(async () => {
      throw new Error('private command output');
    });

    await expect(manager.getStatus()).resolves.toEqual({
      loggedIn: false,
      error: 'auth-status-unavailable',
    });
  });

  it('distinguishes a missing Claude CLI', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const manager = new ClaudeAuthManager(async () => {
      const error = new Error('spawn failed') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    await expect(manager.getStatus()).resolves.toEqual({
      loggedIn: false,
      error: 'claude-cli-not-found',
    });
  });
});

describe('parseClaudeAuthStatus', () => {
  it('accepts a signed-out status', () => {
    expect(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toEqual({
      loggedIn: false,
      method: 'none',
    });
  });

  it('rejects output without a boolean loggedIn field', () => {
    expect(() => parseClaudeAuthStatus('{"email":"private@example.com"}')).toThrow(/loggedIn/);
  });
});
