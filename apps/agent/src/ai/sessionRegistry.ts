/**
 * Session registry — tracks which sessions have been opened via quicksave.
 *
 * Storage layout:
 *   ~/.quicksave/state/session-registry/{encoded-project-path}/{sessionId}.json
 *
 * Path encoding: `/` → `-` (same convention as Claude Code's ~/.claude/projects/).
 *
 * In-memory: two-level Map<cwd, Map<sessionId, entry>>.
 * Loaded once at daemon startup; writes update memory + single file synchronously.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { getSessionRegistryDir } from '../service/singleton.js';
import type { SessionRegistryEntry } from '@sumicom/quicksave-shared';

function encodeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export class SessionRegistry {
  private registry = new Map<string, Map<string, SessionRegistryEntry>>();

  /**
   * Scan session-registry directory and load all entries into memory.
   */
  loadAll(): void {
    const baseDir = getSessionRegistryDir();
    if (!existsSync(baseDir)) return;

    let subdirs: string[];
    try {
      subdirs = readdirSync(baseDir);
    } catch (err) {
      console.error('[sessionRegistry] Failed to read registry dir:', err);
      return;
    }

    for (const subdir of subdirs) {
      const subdirPath = join(baseDir, subdir);
      try {
        if (!statSync(subdirPath).isDirectory()) continue;
      } catch {
        continue;
      }

      let files: string[];
      try {
        files = readdirSync(subdirPath).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of files) {
        try {
          const raw = readFileSync(join(subdirPath, file), 'utf-8');
          const entry = JSON.parse(raw) as SessionRegistryEntry;
          if (!entry.sessionId || !entry.cwd) {
            console.warn(`[sessionRegistry] Skipping invalid entry: ${join(subdir, file)}`);
            continue;
          }
          this.setInMemory(entry);
        } catch (err) {
          console.warn(`[sessionRegistry] Skipping malformed file: ${join(subdir, file)}`, err);
        }
      }
    }

    const totalEntries = Array.from(this.registry.values()).reduce((sum, m) => sum + m.size, 0);
    console.log(`[sessionRegistry] Loaded ${totalEntries} entries from ${this.registry.size} projects`);
  }

  getEntry(cwd: string, sessionId: string): SessionRegistryEntry | undefined {
    return this.registry.get(cwd)?.get(sessionId);
  }

  getEntriesForProject(cwd?: string): SessionRegistryEntry[] {
    if (cwd) {
      const projectMap = this.registry.get(cwd);
      if (!projectMap) return [];
      return Array.from(projectMap.values()).sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
    }
    // Return all entries across all projects
    const all: SessionRegistryEntry[] = [];
    for (const projectMap of this.registry.values()) {
      for (const entry of projectMap.values()) {
        all.push(entry);
      }
    }
    return all.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  }

  upsertEntry(entry: SessionRegistryEntry): void {
    this.setInMemory(entry);
    this.writeToDisk(entry);
  }

  updateEntry(
    cwd: string,
    sessionId: string,
    updates: Partial<SessionRegistryEntry>,
  ): SessionRegistryEntry | null {
    const existing = this.getEntry(cwd, sessionId);
    if (!existing) return null;
    const updated = { ...existing, ...updates };
    this.upsertEntry(updated);
    return updated;
  }

  deleteEntry(cwd: string, sessionId: string): boolean {
    const projectMap = this.registry.get(cwd);
    if (!projectMap || !projectMap.has(sessionId)) return false;

    projectMap.delete(sessionId);
    if (projectMap.size === 0) {
      this.registry.delete(cwd);
    }

    // Remove file
    try {
      const filePath = join(getSessionRegistryDir(), encodeProjectPath(cwd), `${sessionId}.json`);
      unlinkSync(filePath);
    } catch (err) {
      console.error(`[sessionRegistry] Failed to delete file for session=${sessionId}:`, err);
    }

    return true;
  }

  private setInMemory(entry: SessionRegistryEntry): void {
    let projectMap = this.registry.get(entry.cwd);
    if (!projectMap) {
      projectMap = new Map();
      this.registry.set(entry.cwd, projectMap);
    }
    projectMap.set(entry.sessionId, entry);
  }

  private writeToDisk(entry: SessionRegistryEntry): void {
    try {
      const dir = join(getSessionRegistryDir(), encodeProjectPath(entry.cwd));
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const filePath = join(dir, `${entry.sessionId}.json`);
      writeFileSync(filePath, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
    } catch (err) {
      console.error(
        `[sessionRegistry] Failed to write entry for session=${entry.sessionId}:`,
        err,
      );
    }
  }
}

let instance: SessionRegistry | null = null;

export function getSessionRegistry(): SessionRegistry {
  if (!instance) {
    instance = new SessionRegistry();
    instance.loadAll();
  }
  return instance;
}
