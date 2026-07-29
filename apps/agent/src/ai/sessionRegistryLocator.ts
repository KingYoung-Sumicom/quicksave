// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Pure helper for locating a session's registry file by correlation id.
 *
 * Lives in its own side-effect-free module (not `sandboxMcpStdio.ts`, which
 * connects a stdio transport at import time) so it can be unit-tested.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'fs';
import { join } from 'path';

/**
 * Scan `dir` for the registry JSON whose `mcpCorrId` equals `corrId`.
 *
 * Used by the sandbox MCP stdio server on a fresh session, where it has a
 * `--corr` but no `--session-id`: the daemon stamps `mcpCorrId` onto exactly
 * one entry, so the match is exact and 1:1 with the MCP process — safe even
 * when several sessions share a cwd (unlike a "newest file" heuristic).
 *
 * Returns null when the directory is missing or no entry matches yet (the
 * caller should retry, since the daemon may not have written the entry on the
 * very first tool call).
 */
export function findRegistryPathByCorr(dir: string, corrId: string): string | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const file of files) {
    const candidate = join(dir, file);
    try {
      const entry = JSON.parse(readFileSync(candidate, 'utf-8')) as Record<string, unknown>;
      if (entry.mcpCorrId === corrId) return candidate;
    } catch {
      // Skip unreadable / partially-written files.
    }
  }
  return null;
}

/**
 * Locate a registry entry by its provider session id across project folders.
 *
 * OpenCode starts a workspace-scoped MCP process with the workspace as cwd.
 * That cwd may be a symlink-resolved variant of the path Quicksave persisted,
 * so a direct encoded-cwd lookup is not always sufficient. Session ids are
 * globally unique, making this fallback exact without relying on recency.
 */
export function findRegistryPathBySessionId(root: string, sessionId: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  let projects: Dirent<string>[];
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const project of projects) {
    if (!project.isDirectory() || project.name === 'archived') continue;
    const candidate = join(root, project.name, `${sessionId}.json`);
    if (!existsSync(candidate)) continue;
    try {
      const entry = JSON.parse(readFileSync(candidate, 'utf-8')) as Record<string, unknown>;
      if (entry.sessionId === sessionId) return candidate;
    } catch {
      // Skip unreadable / partially-written files.
    }
  }
  return null;
}
