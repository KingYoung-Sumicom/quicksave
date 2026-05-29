// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { buildHookSettings } from '../settingsBuilder.js';

describe('buildHookSettings', () => {
  it('registers one matcher block per requested event', () => {
    const out = buildHookSettings({
      handlerPath: '/abs/handler.js',
      socketPath: '/tmp/sock',
      events: ['Stop', 'PreToolUse', 'PostToolUse'],
    });
    expect(Object.keys(out.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'Stop']);
    for (const ev of ['Stop', 'PreToolUse', 'PostToolUse'] as const) {
      expect(out.hooks[ev]).toHaveLength(1);
      expect(out.hooks[ev][0].matcher).toBe('*');
      expect(out.hooks[ev][0].hooks).toHaveLength(1);
      expect(out.hooks[ev][0].hooks[0].type).toBe('command');
    }
  });

  it('builds a node-invoking command with quoted handler + socket paths', () => {
    const out = buildHookSettings({
      handlerPath: '/abs/handler.js',
      socketPath: '/tmp/sock',
      events: ['Stop'],
    });
    const cmd = out.hooks['Stop'][0].hooks[0].command;
    expect(cmd).toContain(`'node'`);
    expect(cmd).toContain(`'/abs/handler.js'`);
    expect(cmd).toContain(`'/tmp/sock'`);
  });

  it('escapes single quotes in paths', () => {
    const out = buildHookSettings({
      handlerPath: `/abs/it's/handler.js`,
      socketPath: '/tmp/sock',
      events: ['Stop'],
    });
    const cmd = out.hooks['Stop'][0].hooks[0].command;
    // Single quote should be escaped via the '\'' trick to keep the surrounding
    // single-quote string valid in POSIX shells.
    expect(cmd).toContain(`'/abs/it'\\''s/handler.js'`);
  });

  it('honors nodeBin override and matcher override', () => {
    const out = buildHookSettings({
      handlerPath: '/h',
      socketPath: '/s',
      events: ['PreToolUse'],
      matcher: 'Bash',
      nodeBin: '/usr/local/bin/node',
    });
    expect(out.hooks['PreToolUse'][0].matcher).toBe('Bash');
    expect(out.hooks['PreToolUse'][0].hooks[0].command).toContain(`'/usr/local/bin/node'`);
  });
});
