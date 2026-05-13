// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pathToHash, resolveHash } from './pathHash';

// We test pathToHash and resolveHash as pure functions.
// getAllKnownPaths depends on Zustand stores with complex initialization,
// so we mock those stores to test it.

describe('pathHash', () => {
  describe('pathToHash', () => {
    it('returns an 8-character hex string', () => {
      const hash = pathToHash('/home/user/repo');
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('is deterministic', () => {
      const h1 = pathToHash('/home/user/repo');
      const h2 = pathToHash('/home/user/repo');
      expect(h1).toBe(h2);
    });

    it('produces different hashes for different paths', () => {
      const h1 = pathToHash('/home/user/repo-a');
      const h2 = pathToHash('/home/user/repo-b');
      expect(h1).not.toBe(h2);
    });

    it('handles empty string', () => {
      const hash = pathToHash('');
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('pads short hashes to 8 chars', () => {
      // Single char path should still produce 8-char hex
      const hash = pathToHash('a');
      expect(hash).toHaveLength(8);
    });
  });

  describe('resolveHash', () => {
    it('resolves a hash to the matching path', () => {
      const paths = ['/home/user/repo-a', '/home/user/repo-b', '/home/user/repo-c'];
      const hash = pathToHash('/home/user/repo-b');
      expect(resolveHash(hash, paths)).toBe('/home/user/repo-b');
    });

    it('returns undefined for unmatched hash', () => {
      const paths = ['/home/user/repo-a'];
      expect(resolveHash('00000000', paths)).toBeUndefined();
    });

    it('returns undefined for empty paths array', () => {
      const hash = pathToHash('/some/path');
      expect(resolveHash(hash, [])).toBeUndefined();
    });

    it('returns first match when multiple paths have same hash (unlikely)', () => {
      // In practice collisions are extremely rare, but test the behavior
      const paths = ['/a', '/b'];
      const hash = pathToHash('/a');
      const result = resolveHash(hash, paths);
      expect(result).toBe('/a');
    });
  });

  describe('getAllKnownPaths', () => {
    it('combines paths from machineStore and connectionStore', async () => {
      // Reset module registry to inject mocks
      vi.resetModules();

      // Mock the stores
      vi.doMock('../stores/machineStore', () => ({
        useMachineStore: {
          getState: () => ({
            getMachine: (agentId: string) => ({
              knownRepos: ['/repo1', '/repo2'],
              knownCodingPaths: ['/code1'],
            }),
          }),
        },
      }));
      vi.doMock('../stores/connectionStore', () => ({
        useConnectionStore: {
          getState: () => ({
            availableRepos: [{ path: '/repo2' }, { path: '/repo3' }],
            availableCodingPaths: [{ path: '/code2' }],
            repoPath: '/repo1',
            agentId: 'agent-1',
            agentConnections: {},
          }),
        },
      }));

      const { getAllKnownPaths } = await import('./pathHash');
      const paths = getAllKnownPaths('agent-1');

      // Should have deduplicated: /repo1, /repo2, /code1, /repo3, /code2
      expect(paths).toContain('/repo1');
      expect(paths).toContain('/repo2');
      expect(paths).toContain('/repo3');
      expect(paths).toContain('/code1');
      expect(paths).toContain('/code2');
      // /repo1 appears in both knownRepos and repoPath, should be deduplicated
      const repo1Count = paths.filter((p: string) => p === '/repo1').length;
      expect(repo1Count).toBe(1);

      vi.restoreAllMocks();
    });

    it('uses connected per-agent paths and drops stale persisted repos', async () => {
      vi.resetModules();

      vi.doMock('../stores/machineStore', () => ({
        useMachineStore: {
          getState: () => ({
            getMachine: () => ({
              knownRepos: ['/Users/jimmy/workspace/old-repo'],
              knownCodingPaths: ['/Users/jimmy/workspace'],
              cachedProjects: {
                '/Users/jimmy/workspace/old-repo': {
                  lastActivityAt: 1,
                  sessionCount: 1,
                  repos: [{ path: '/Users/jimmy/workspace/old-repo', name: 'old-repo' }],
                },
                '/home/jimmy/workspace/new-repo': {
                  lastActivityAt: 2,
                  sessionCount: 1,
                  repos: [{ path: '/home/jimmy/workspace/new-repo/sub', name: 'sub' }],
                },
              },
            }),
          }),
        },
      }));
      vi.doMock('../stores/connectionStore', () => ({
        useConnectionStore: {
          getState: () => ({
            availableRepos: [],
            availableCodingPaths: [],
            repoPath: null,
            agentId: null,
            agentConnections: {
              'agent-1': {
                state: 'connected',
                repoPath: '/home/jimmy/workspace/new-repo',
                availableRepos: [{ path: '/home/jimmy/workspace/new-repo' }],
                availableCodingPaths: [],
              },
            },
          }),
        },
      }));

      const { getAllKnownPaths } = await import('./pathHash');
      const paths = getAllKnownPaths('agent-1');

      expect(paths).toContain('/home/jimmy/workspace/new-repo');
      expect(paths).toContain('/home/jimmy/workspace/new-repo/sub');
      expect(paths).not.toContain('/Users/jimmy/workspace/old-repo');
      expect(paths).not.toContain('/Users/jimmy/workspace');

      vi.restoreAllMocks();
    });

    it('handles missing machine gracefully', async () => {
      vi.resetModules();

      vi.doMock('../stores/machineStore', () => ({
        useMachineStore: {
          getState: () => ({
            getMachine: () => undefined,
          }),
        },
      }));
      vi.doMock('../stores/connectionStore', () => ({
        useConnectionStore: {
          getState: () => ({
            availableRepos: [],
            availableCodingPaths: [],
            repoPath: null,
            agentId: null,
            agentConnections: {},
          }),
        },
      }));

      const { getAllKnownPaths } = await import('./pathHash');
      const paths = getAllKnownPaths('nonexistent');
      expect(paths).toEqual([]);

      vi.restoreAllMocks();
    });
  });
});
