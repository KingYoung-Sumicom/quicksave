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
  const knownRepos = machine?.knownRepos || [];
  const knownCodingPaths = machine?.knownCodingPaths || [];
  const cachedRepoPaths = machine?.cachedProjects
    ? Object.values(machine.cachedProjects).flatMap((p) => p.repos?.map((r) => r.path) ?? [])
    : [];
  const { availableRepos, availableCodingPaths, repoPath } = useConnectionStore.getState();
  const repoPaths = availableRepos.map((r) => r.path);
  const codingPaths = availableCodingPaths.map((p) => p.path);
  const all = new Set([
    ...knownRepos,
    ...knownCodingPaths,
    ...cachedRepoPaths,
    ...repoPaths,
    ...codingPaths,
  ]);
  if (repoPath) all.add(repoPath);
  return [...all];
}
