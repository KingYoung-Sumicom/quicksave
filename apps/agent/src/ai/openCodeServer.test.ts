// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
//
// Tests for openCodeServer env knobs.
import { describe, it, expect, afterEach } from 'vitest';
import {
  buildAutoReviewPermissionRuleset,
  getOpenCodeCompactTimeoutMs,
} from './openCodeServer.js';

const ENV_KEY = 'QUICKSAVE_OPENCODE_COMPACT_TIMEOUT_MS';

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe('getOpenCodeCompactTimeoutMs', () => {
  it('defaults to 600s when unset', () => {
    delete process.env[ENV_KEY];
    expect(getOpenCodeCompactTimeoutMs()).toBe(600_000);
  });

  it('honors a valid env override', () => {
    process.env[ENV_KEY] = '900000';
    expect(getOpenCodeCompactTimeoutMs()).toBe(900_000);
  });

  it('falls back to the default on non-numeric or non-positive values', () => {
    process.env[ENV_KEY] = 'abc';
    expect(getOpenCodeCompactTimeoutMs()).toBe(600_000);
    process.env[ENV_KEY] = '0';
    expect(getOpenCodeCompactTimeoutMs()).toBe(600_000);
    process.env[ENV_KEY] = '-5000';
    expect(getOpenCodeCompactTimeoutMs()).toBe(600_000);
  });
});

describe('buildAutoReviewPermissionRuleset', () => {
  it('asks for every unknown permission and only allows explicit safe categories', () => {
    expect(buildAutoReviewPermissionRuleset()).toEqual([
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: 'grep', pattern: '*', action: 'allow' },
      { permission: 'glob', pattern: '*', action: 'allow' },
      { permission: 'list', pattern: '*', action: 'allow' },
      { permission: 'lsp', pattern: '*', action: 'allow' },
      { permission: 'todowrite', pattern: '*', action: 'allow' },
      { permission: 'question', pattern: '*', action: 'allow' },
      { permission: 'doom_loop', pattern: '*', action: 'allow' },
    ]);
  });
});
