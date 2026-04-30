// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { pathToHash, resolveHash, getAllKnownPaths } from './pathHash';

/**
 * Build a composite project ID from agent ID and cwd.
 * Format: `{agentId}:{pathHash}` — URL-safe, deterministic.
 */
export function toProjectId(agentId: string, cwd: string): string {
  return `${agentId}:${pathToHash(cwd)}`;
}

/**
 * Split a project ID into its components.
 */
export function fromProjectId(projectId: string): { agentId: string; pathHash: string } {
  const idx = projectId.indexOf(':');
  if (idx === -1) return { agentId: projectId, pathHash: '' };
  return {
    agentId: projectId.slice(0, idx),
    pathHash: projectId.slice(idx + 1),
  };
}

/**
 * Resolve a project ID back to agentId + full cwd path.
 * Uses persisted + live known paths for hash resolution.
 */
export function resolveProjectCwd(projectId: string): { agentId: string; cwd: string | undefined } {
  const { agentId, pathHash } = fromProjectId(projectId);
  const cwd = resolveHash(pathHash, getAllKnownPaths(agentId));
  return { agentId, cwd };
}
