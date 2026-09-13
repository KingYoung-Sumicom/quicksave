// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { LEGACY_BUS_VERBS } from './legacyBusAdapter.js';

describe('LEGACY_BUS_VERBS', () => {
  it('exposes the Codex CLI update commands to MessageBus clients', () => {
    expect(LEGACY_BUS_VERBS).toContain('codex:check-update');
    expect(LEGACY_BUS_VERBS).toContain('codex:update');
  });
});
