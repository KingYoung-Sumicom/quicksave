// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { resolveHookCommand } from '../provider.js';
import { buildHookSettings } from '../settingsBuilder.js';

// Under vitest we run from source (tsx), so only hookHandler.ts exists next to
// provider.ts — resolveHookCommand takes its dev branch.
describe('resolveHookCommand (dev/tsx)', () => {
  it('resolves tsx by absolute path, never the multi-word `npx tsx`', () => {
    const { interpreter, handlerPath } = resolveHookCommand();
    // Regression: `npx tsx` (a) gets single-quoted as one shell token by
    // buildHookSettings → `sh: 1: npx tsx: not found`, and (b) can't resolve
    // the non-hoisted tsx from claude's cwd. Both are avoided by pointing at
    // the agent package's own .bin/tsx.
    expect(interpreter).not.toContain(' ');
    expect(interpreter).not.toContain('npx');
    expect(interpreter.endsWith('/node_modules/.bin/tsx')).toBe(true);
    expect(handlerPath.endsWith('/hookHandler.ts')).toBe(true);
  });

  it('produces a hook command whose interpreter is a single valid shell token', () => {
    const { interpreter, handlerPath } = resolveHookCommand();
    const cmd = buildHookSettings({
      handlerPath,
      socketPath: '/tmp/sock',
      events: ['Stop'],
      nodeBin: interpreter,
    }).hooks['Stop'][0].hooks[0].command;
    // The interpreter must appear as one quoted token, not split across words.
    expect(cmd).toContain(`'${interpreter}'`);
    expect(cmd.startsWith(`'${interpreter}' `)).toBe(true);
  });
});
