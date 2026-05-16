// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useMachineStore } from '../stores/machineStore';
import { useConnectionStore } from '../stores/connectionStore';

/**
 * DJB2 hash → full 32-bit → 8-char hex.
 * Deterministic, collision-free for practical use (~4B values).
 */
export function pathToHash(path: string): string {
  let hash = 5381;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) + hash + path.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Resolve a hash back to a full path from an array of known paths.
 */
export function resolveHash(hash: string, knownPaths: string[]): string | undefined {
  return knownPaths.find((p) => pathToHash(p) === hash);
}

/**
 * Collect all known paths for an agent from persisted + in-memory stores.
 * Works before handshake (machineStore from localStorage) and after (connectionStore).
 * Also includes per-project nested/submodule repos cached in machineStore so
 * `/p/:projectId/r/:repoId` can resolve a repoId picked from ProjectDetail.
 */
export function getAllKnownPaths(agentId: string): string[] {
  const machine = useMachineStore.getState().getMachine(agentId);
  const connection = useConnectionStore.getState();
  const agentConn = connection.agentConnections?.[agentId];

  if (agentConn?.state === 'connected') {
    const repoPaths = agentConn.availableRepos.map((r) => r.path);
    const codingPaths = agentConn.availableCodingPaths.map((p) => p.path);
    const liveRoots = new Set([...repoPaths, ...codingPaths]);
    if (agentConn.repoPath) liveRoots.add(agentConn.repoPath);

    const cachedRepoPaths = machine?.cachedProjects
      ? Object.entries(machine.cachedProjects).flatMap(([cwd, project]) => {
          const belongsToLiveRoot = [...liveRoots].some((root) => root === cwd || cwd.startsWith(root + '/'));
          return belongsToLiveRoot ? project.repos?.map((r) => r.path) ?? [] : [];
        })
      : [];

    // Include persisted knownRepos/knownCodingPaths so that hashes recorded
    // from previous sessions remain resolvable after a new handshake.
    // Without this, paths that are no longer in availableRepos (e.g. a coding
    // path was removed from the agent config) would stop resolving the moment
    // the connection is established, causing the viewer to flip to "unavailable".
    const knownRepos = machine?.knownRepos ?? [];
    const knownCodingPaths = machine?.knownCodingPaths ?? [];

    const all = new Set([...repoPaths, ...codingPaths, ...cachedRepoPaths, ...knownRepos, ...knownCodingPaths]);
    if (agentConn.repoPath) all.add(agentConn.repoPath);
    return [...all];
  }

  const knownRepos = machine?.knownRepos || [];
  const knownCodingPaths = machine?.knownCodingPaths || [];
  const cachedRepoPaths = machine?.cachedProjects
    ? Object.values(machine.cachedProjects).flatMap((p) => p.repos?.map((r) => r.path) ?? [])
    : [];
  const repoPaths =
    connection.agentId === agentId ? connection.availableRepos.map((r) => r.path) : [];
  const codingPaths =
    connection.agentId === agentId ? connection.availableCodingPaths.map((p) => p.path) : [];
  const all = new Set([
    ...knownRepos,
    ...knownCodingPaths,
    ...cachedRepoPaths,
    ...repoPaths,
    ...codingPaths,
  ]);
  if (connection.agentId === agentId && connection.repoPath) all.add(connection.repoPath);
  return [...all];
}
