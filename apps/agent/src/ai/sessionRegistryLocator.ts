// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Pure helper for locating a session's registry file by correlation id.
 *
 * Lives in its own side-effect-free module (not `sandboxMcpStdio.ts`, which
 * connects a stdio transport at import time) so it can be unit-tested.
 */
import { readdirSync, readFileSync } from 'fs';
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
