// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { resolveGitRepoScope } from './SessionRightPanel';

describe('resolveGitRepoScope', () => {
  it('does not auto-select a child repo for a non-git workspace cwd', () => {
    expect(
      resolveGitRepoScope('/home/jimmy/Documents', null, [
        { path: '/home/jimmy/Documents/kindergarden-map' },
      ]),
    ).toBeNull();
  });

  it('uses the containing repo root for a session cwd inside a repo', () => {
    expect(
      resolveGitRepoScope('/home/jimmy/workspace/quicksave/apps/pwa', null, [
        { path: '/home/jimmy/workspace' },
        { path: '/home/jimmy/workspace/quicksave' },
      ]),
    ).toBe('/home/jimmy/workspace/quicksave');
  });

  it('honors an explicit repo override', () => {
    expect(
      resolveGitRepoScope('/home/jimmy/Documents', '/home/jimmy/Documents/kindergarden-map/', []),
    ).toBe('/home/jimmy/Documents/kindergarden-map');
  });
});
