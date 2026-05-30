// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { ResumeSessionOpts, StartSessionOpts } from '../../provider.js';
import { buildThreadResumeParams, buildThreadStartParams } from '../provider.js';

describe('CodexAppServerProvider history persistence', () => {
  it('enables extended history when starting a thread', () => {
    const opts: StartSessionOpts = {
      prompt: 'start',
      cwd: '/tmp/quicksave-codex-history',
      permissionLevel: 'default',
      sandboxed: true,
    };

    expect(buildThreadStartParams(opts).persistExtendedHistory).toBe(true);
  });

  it('enables extended history when resuming a thread', () => {
    const opts: ResumeSessionOpts = {
      sessionId: 'thr_history',
      prompt: 'continue',
      cwd: '/tmp/quicksave-codex-history',
      permissionLevel: 'default',
      sandboxed: true,
    };

    expect(buildThreadResumeParams(opts).persistExtendedHistory).toBe(true);
  });
});
