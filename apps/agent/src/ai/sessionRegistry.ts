/**
 * Session registry — tracks which sessions have been opened via quicksave.
 *
 * Storage layout:
 *   ~/.quicksave/state/session-registry/{encoded-project-path}/{sessionId}.json           ← active
 *   ~/.quicksave/state/session-registry/archived/{encoded-project-path}/{sessionId}.json  ← cold
 *
 * Path encoding: `/` → `-` (same convention as Claude Code's ~/.claude/projects/).
 *
 * In-memory: two-level Map<cwd, Map<sessionId, entry>> holding ONLY active entries.
 * Archived entries live on disk only; they're read on-demand when the caller
 * asks for them (listArchivedEntries / readArchivedEntry) and moved between
 * the two subtrees when the `archived` flag is flipped via upsertEntry /
 * updateEntry.
 *
 * This keeps daemon cold-start and PWA sync bandwidth proportional to the
 * number of *active* sessions, not the full historical total.
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

const ARCHIVED_SUBDIR = 'archived';

function encodeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export class SessionRegistry {
  private registry = new Map<string, Map<string, SessionRegistryEntry>>();

  /**
   * Scan session-registry directory and load all ACTIVE entries into memory.
   * Entries found with `archived: true` in the active subtree are migrated
   * to the archived subtree (one-time legacy migration) and not loaded.
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

    let migrated = 0;
    for (const subdir of subdirs) {
      if (subdir === ARCHIVED_SUBDIR) continue; // never load archived into memory
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
        const filePath = join(subdirPath, file);
        try {
          const raw = readFileSync(filePath, 'utf-8');
          const entry = JSON.parse(raw) as SessionRegistryEntry;
          if (!entry.sessionId || !entry.cwd) {
            console.warn(`[sessionRegistry] Skipping invalid entry: ${join(subdir, file)}`);
            continue;
          }
          if (entry.archived) {
            // Legacy migration: archived entry in the active subtree → move it.
            this.writeArchivedFile(entry);
            try {
              unlinkSync(filePath);
              migrated++;
            } catch (err) {
              console.warn(`[sessionRegistry] Migration: failed to remove active copy ${filePath}`, err);
            }
            continue;
          }
          this.setInMemory(entry);
        } catch (err) {
          console.warn(`[sessionRegistry] Skipping malformed file: ${join(subdir, file)}`, err);
        }
      }
    }

    const totalEntries = Array.from(this.registry.values()).reduce((sum, m) => sum + m.size, 0);
    const migrationNote = migrated > 0 ? ` (migrated ${migrated} archived entries)` : '';
    console.log(
      `[sessionRegistry] Loaded ${totalEntries} active entries from ${this.registry.size} projects${migrationNote}`,
    );
  }

  getEntry(cwd: string, sessionId: string): SessionRegistryEntry | undefined {
    return this.registry.get(cwd)?.get(sessionId);
  }

  /** Scan active projects for a session by id. Archived entries are NOT searched. */
  findBySessionId(sessionId: string): SessionRegistryEntry | undefined {
    for (const projectMap of this.registry.values()) {
      const entry = projectMap.get(sessionId);
      if (entry) return entry;
    }
    return undefined;
  }

  /** Active entries only — archived entries are never in memory. */
  getEntriesForProject(cwd?: string): SessionRegistryEntry[] {
    if (cwd) {
      const projectMap = this.registry.get(cwd);
      if (!projectMap) return [];
      return Array.from(projectMap.values()).sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
    }
    const all: SessionRegistryEntry[] = [];
    for (const projectMap of this.registry.values()) {
      for (const entry of projectMap.values()) {
        all.push(entry);
      }
    }
    return all.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  }

  /** Read a single archived entry from disk (not cached in memory). */
  readArchivedEntry(cwd: string, sessionId: string): SessionRegistryEntry | undefined {
    const path = this.archivedFilePath(cwd, sessionId);
    if (!existsSync(path)) return undefined;
    try {
      const raw = readFileSync(path, 'utf-8');
      const entry = JSON.parse(raw) as SessionRegistryEntry;
      if (!entry.sessionId || !entry.cwd) return undefined;
      return entry;
    } catch (err) {
      console.warn(`[sessionRegistry] Failed to read archived entry ${sessionId}:`, err);
      return undefined;
    }
  }

  /**
   * List archived entries from disk for a project (or across all projects).
   * Reads and parses files on demand — do not call on a hot path.
   */
  listArchivedEntries(cwd?: string): SessionRegistryEntry[] {
    const archivedRoot = join(getSessionRegistryDir(), ARCHIVED_SUBDIR);
    if (!existsSync(archivedRoot)) return [];

    const entries: SessionRegistryEntry[] = [];
    const projectDirs = cwd ? [encodeProjectPath(cwd)] : this.listArchivedProjectDirs(archivedRoot);

    for (const projectDir of projectDirs) {
      const projectPath = join(archivedRoot, projectDir);
      let files: string[];
      try {
        files = readdirSync(projectPath).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const raw = readFileSync(join(projectPath, file), 'utf-8');
          const entry = JSON.parse(raw) as SessionRegistryEntry;
          if (entry.sessionId && entry.cwd) entries.push(entry);
        } catch (err) {
          console.warn(`[sessionRegistry] Skipping malformed archived file ${file}:`, err);
        }
      }
    }
    return entries.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  }

  /**
   * Persist an entry. Routes to active or archived subtree based on
   * `entry.archived`, and removes any stale copy from the other subtree so
   * transitions (archive / unarchive) are atomic from the caller's view.
   */
  upsertEntry(entry: SessionRegistryEntry): void {
    if (entry.archived) {
      this.removeFromMemory(entry.cwd, entry.sessionId);
      this.unlinkActiveFile(entry.cwd, entry.sessionId);
      this.writeArchivedFile(entry);
    } else {
      this.unlinkArchivedFile(entry.cwd, entry.sessionId);
      this.setInMemory(entry);
      this.writeActiveFile(entry);
    }
  }

  /**
   * Merge a partial update into an existing entry (active or archived).
   * Returns the updated entry, or null if no entry with that id exists.
   */
  updateEntry(
    cwd: string,
    sessionId: string,
    updates: Partial<SessionRegistryEntry>,
  ): SessionRegistryEntry | null {
    const existing =
      this.getEntry(cwd, sessionId) ?? this.readArchivedEntry(cwd, sessionId);
    if (!existing) return null;
    const updated = { ...existing, ...updates };
    this.upsertEntry(updated);
    return updated;
  }

  /** Remove from memory + both disk subtrees. */
  deleteEntry(cwd: string, sessionId: string): boolean {
    const hadInMemory = this.removeFromMemory(cwd, sessionId);
    const removedActive = this.unlinkActiveFile(cwd, sessionId);
    const removedArchived = this.unlinkArchivedFile(cwd, sessionId);
    return hadInMemory || removedActive || removedArchived;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private setInMemory(entry: SessionRegistryEntry): void {
    let projectMap = this.registry.get(entry.cwd);
    if (!projectMap) {
      projectMap = new Map();
      this.registry.set(entry.cwd, projectMap);
    }
    projectMap.set(entry.sessionId, entry);
  }

  private removeFromMemory(cwd: string, sessionId: string): boolean {
    const projectMap = this.registry.get(cwd);
    if (!projectMap || !projectMap.has(sessionId)) return false;
    projectMap.delete(sessionId);
    if (projectMap.size === 0) this.registry.delete(cwd);
    return true;
  }

  private activeFilePath(cwd: string, sessionId: string): string {
    return join(getSessionRegistryDir(), encodeProjectPath(cwd), `${sessionId}.json`);
  }

  private archivedFilePath(cwd: string, sessionId: string): string {
    return join(
      getSessionRegistryDir(),
      ARCHIVED_SUBDIR,
      encodeProjectPath(cwd),
      `${sessionId}.json`,
    );
  }

  private writeActiveFile(entry: SessionRegistryEntry): void {
    try {
      const dir = join(getSessionRegistryDir(), encodeProjectPath(entry.cwd));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.activeFilePath(entry.cwd, entry.sessionId), JSON.stringify(entry, null, 2) + '\n', 'utf-8');
    } catch (err) {
      console.error(`[sessionRegistry] Failed to write active entry session=${entry.sessionId}:`, err);
    }
  }

  private writeArchivedFile(entry: SessionRegistryEntry): void {
    try {
      const dir = join(getSessionRegistryDir(), ARCHIVED_SUBDIR, encodeProjectPath(entry.cwd));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.archivedFilePath(entry.cwd, entry.sessionId), JSON.stringify(entry, null, 2) + '\n', 'utf-8');
    } catch (err) {
      console.error(`[sessionRegistry] Failed to write archived entry session=${entry.sessionId}:`, err);
    }
  }

  private unlinkActiveFile(cwd: string, sessionId: string): boolean {
    const path = this.activeFilePath(cwd, sessionId);
    if (!existsSync(path)) return false;
    try {
      unlinkSync(path);
      return true;
    } catch (err) {
      console.error(`[sessionRegistry] Failed to unlink active file session=${sessionId}:`, err);
      return false;
    }
  }

  private unlinkArchivedFile(cwd: string, sessionId: string): boolean {
    const path = this.archivedFilePath(cwd, sessionId);
    if (!existsSync(path)) return false;
    try {
      unlinkSync(path);
      return true;
    } catch (err) {
      console.error(`[sessionRegistry] Failed to unlink archived file session=${sessionId}:`, err);
      return false;
    }
  }

  private listArchivedProjectDirs(archivedRoot: string): string[] {
    try {
      return readdirSync(archivedRoot).filter((d) => {
        try {
          return statSync(join(archivedRoot, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
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

/** Reset the singleton — only for tests. */
export function resetSessionRegistry(): void {
  instance = null;
}
