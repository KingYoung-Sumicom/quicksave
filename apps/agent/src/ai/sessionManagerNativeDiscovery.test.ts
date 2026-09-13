// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';

import { SessionManager } from './sessionManager.js';
import type { CodingAgentProvider } from './provider.js';

describe('SessionManager native discovery', () => {
  it('passes every managed project path to Codex discovery', async () => {
    const codexProvider = {
      id: 'codex',
      historyMode: 'codex-thread',
      startSession: vi.fn(),
      resumeSession: vi.fn(),
      listNativeSessions: vi.fn().mockResolvedValue([]),
    } satisfies CodingAgentProvider;
    const manager = new SessionManager([codexProvider], 'codex');
    manager.setProjectDirectories(['/repo-a', '/repo-b']);

    await manager.listNativeSessions();

    expect(codexProvider.listNativeSessions).toHaveBeenCalledWith({
      cwd: ['/repo-a', '/repo-b'],
    });
  });
});
