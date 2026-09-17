// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { LEGACY_BUS_VERBS } from './legacyBusAdapter.js';

describe('LEGACY_BUS_VERBS', () => {
  it('exposes the Codex CLI update commands to MessageBus clients', () => {
    expect(LEGACY_BUS_VERBS).toContain('codex:check-update');
    expect(LEGACY_BUS_VERBS).toContain('codex:update');
  });

  it('exposes every opencode: verb the PWA invokes', () => {
    // A verb missing from this allowlist is never registered as a bus
    // handler and the PWA receives "Unknown command: <verb>".
    for (const verb of [
      'opencode:config-snapshot',
      'opencode:mcp-upsert',
      'opencode:mcp-remove',
      'opencode:websearch-update',
      'opencode:guardian-update',
      'opencode:guardian-test',
    ]) {
      expect(LEGACY_BUS_VERBS, `missing bus verb: ${verb}`).toContain(verb);
    }
  });
});
