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
 */
export function getAllKnownPaths(agentId: string): string[] {
  const machine = useMachineStore.getState().getMachine(agentId);
  const knownRepos = machine?.knownRepos || [];
  const knownCodingPaths = machine?.knownCodingPaths || [];
  const { availableRepos, availableCodingPaths, repoPath } = useConnectionStore.getState();
  const repoPaths = availableRepos.map((r) => r.path);
  const codingPaths = availableCodingPaths.map((p) => p.path);
  const all = new Set([...knownRepos, ...knownCodingPaths, ...repoPaths, ...codingPaths]);
  if (repoPath) all.add(repoPath);
  return [...all];
}

/**
 * Build a URL path for agent routes.
 * @param section 'repo' or 'coding'
 * @param suffix optional sub-path like a sessionId
 */
export function agentUrl(
  agentId: string,
  section: 'repo' | 'coding',
  path: string | null,
  suffix?: string,
): string {
  const hash = path ? pathToHash(path) : '_';
  const base = `/agent/${agentId}/${section}/${hash}`;
  return suffix ? `${base}/${suffix}` : base;
}
