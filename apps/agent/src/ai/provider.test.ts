// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
//
// Tests for the per-agent permission-level normalization helpers.

import { describe, it, expect } from 'vitest';
import {
  normalizePermissionLevelForAgent,
  isPermissionLevelAcceptedForAgent,
  isFullAccessPermission,
  defaultPermissionLevelForAgent,
} from './provider.js';

describe('normalizePermissionLevelForAgent (opencode)', () => {
  it('passes through opencode-native levels', () => {
    expect(normalizePermissionLevelForAgent('opencode', 'default')).toBe('default');
    expect(normalizePermissionLevelForAgent('opencode', 'auto')).toBe('auto');
    expect(normalizePermissionLevelForAgent('opencode', 'auto-review')).toBe('auto-review');
  });

  it('maps legacy bypassPermissions onto auto (OpenCode --yolo is an alias of --auto)', () => {
    expect(normalizePermissionLevelForAgent('opencode', 'bypassPermissions')).toBe('auto');
  });

  it('still accepts legacy bypassPermissions for validation of stored values', () => {
    expect(isPermissionLevelAcceptedForAgent('opencode', 'bypassPermissions')).toBe(true);
    expect(isPermissionLevelAcceptedForAgent('opencode', 'auto-review')).toBe(true);
    expect(isPermissionLevelAcceptedForAgent('opencode', 'not-a-mode')).toBe(false);
  });

  it('falls back to the agent default for unknown values', () => {
    expect(normalizePermissionLevelForAgent('opencode', 'whatever'))
      .toBe(defaultPermissionLevelForAgent('opencode'));
  });
});

describe('normalizePermissionLevelForAgent (claude-code)', () => {
  it('keeps bypassPermissions as a distinct full-access level', () => {
    expect(normalizePermissionLevelForAgent('claude-code', 'bypassPermissions')).toBe('bypassPermissions');
    expect(isFullAccessPermission('claude-code', 'bypassPermissions')).toBe(true);
    expect(isFullAccessPermission('claude-code', 'auto')).toBe(false);
  });
});
