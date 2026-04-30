// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SessionRegistryEntry } from '@sumicom/quicksave-shared';

let tempDir: string;

vi.mock('../service/singleton.js', () => ({
  getSessionRegistryDir: () => tempDir,
}));

const { SessionRegistry } = await import('./sessionRegistry.js');

function makeEntry(overrides: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry {
  return {
    sessionId: 'sess-1',
    cwd: '/home/user/project-a',
    agent: 'claude-code',
    repoName: 'project-a',
    gitBranch: 'main',
    title: 'Test session',
    firstPrompt: 'hello',
    createdAt: 1000,
    lastAccessedAt: 2000,
    ...overrides,
  };
}

describe('SessionRegistry', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessionRegistry-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('upsertEntry', () => {
    it('creates a new entry and persists it to disk', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry();
      registry.upsertEntry(entry);

      // In memory
      expect(registry.getEntry(entry.cwd, entry.sessionId)).toEqual(entry);

      // On disk
      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const filePath = join(tempDir, encodedCwd, `${entry.sessionId}.json`);
      expect(existsSync(filePath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(onDisk).toEqual(entry);
    });

    it('overwrites an existing entry with the same cwd and sessionId', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry();
      registry.upsertEntry(entry);

      const updated = makeEntry({ title: 'Updated title', lastAccessedAt: 3000 });
      registry.upsertEntry(updated);

      expect(registry.getEntry(entry.cwd, entry.sessionId)).toEqual(updated);
      // Only one entry for this project
      expect(registry.getEntriesForProject(entry.cwd)).toHaveLength(1);
    });

    it('stores multiple sessions under the same cwd', () => {
      const registry = new SessionRegistry();
      registry.upsertEntry(makeEntry({ sessionId: 'sess-1' }));
      registry.upsertEntry(makeEntry({ sessionId: 'sess-2' }));

      expect(registry.getEntriesForProject('/home/user/project-a')).toHaveLength(2);
    });

    it('stores sessions under different cwds independently', () => {
      const registry = new SessionRegistry();
      registry.upsertEntry(makeEntry({ cwd: '/project-a', sessionId: 'sess-1' }));
      registry.upsertEntry(makeEntry({ cwd: '/project-b', sessionId: 'sess-2' }));

      expect(registry.getEntriesForProject('/project-a')).toHaveLength(1);
      expect(registry.getEntriesForProject('/project-b')).toHaveLength(1);
    });
  });

  describe('getEntry', () => {
    it('returns undefined for a missing cwd', () => {
      const registry = new SessionRegistry();
      expect(registry.getEntry('/nonexistent', 'sess-1')).toBeUndefined();
    });

    it('returns undefined for a missing sessionId within an existing cwd', () => {
      const registry = new SessionRegistry();
      registry.upsertEntry(makeEntry());
      expect(registry.getEntry('/home/user/project-a', 'no-such-session')).toBeUndefined();
    });

    it('preserves externally written status fields when rewriting an active entry', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry({ title: undefined, stage: undefined, note: undefined });
      registry.upsertEntry(entry);

      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const filePath = join(tempDir, encodedCwd, `${entry.sessionId}.json`);
      writeFileSync(filePath, JSON.stringify({
        ...entry,
        title: 'External title',
        stage: 'working',
        blocked: false,
        note: 'external note',
        noteHistory: [{ ts: 123, text: 'external note' }],
      }, null, 2));

      registry.upsertEntry({ ...entry, messageCount: 3, lastAccessedAt: 3000 });

      const onDisk = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(onDisk.title).toBe('External title');
      expect(onDisk.stage).toBe('working');
      expect(onDisk.blocked).toBe(false);
      expect(onDisk.note).toBe('external note');
      expect(onDisk.noteHistory).toEqual([{ ts: 123, text: 'external note' }]);
      expect(onDisk.messageCount).toBe(3);
    });

    it('returns the correct entry', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry();
      registry.upsertEntry(entry);
      expect(registry.getEntry(entry.cwd, entry.sessionId)).toEqual(entry);
    });
  });

  describe('getEntriesForProject', () => {
    it('returns empty array for unknown cwd', () => {
      const registry = new SessionRegistry();
      expect(registry.getEntriesForProject('/unknown')).toEqual([]);
    });

    it('returns entries sorted by lastAccessedAt descending', () => {
      const registry = new SessionRegistry();
      registry.upsertEntry(makeEntry({ sessionId: 'old', lastAccessedAt: 1000 }));
      registry.upsertEntry(makeEntry({ sessionId: 'new', lastAccessedAt: 3000 }));
      registry.upsertEntry(makeEntry({ sessionId: 'mid', lastAccessedAt: 2000 }));

      const entries = registry.getEntriesForProject('/home/user/project-a');
      expect(entries.map((e) => e.sessionId)).toEqual(['new', 'mid', 'old']);
    });

    it('returns all entries across projects when cwd is undefined', () => {
      const registry = new SessionRegistry();
      registry.upsertEntry(makeEntry({ cwd: '/proj-a', sessionId: 's1', lastAccessedAt: 1000 }));
      registry.upsertEntry(makeEntry({ cwd: '/proj-b', sessionId: 's2', lastAccessedAt: 2000 }));

      const all = registry.getEntriesForProject(undefined);
      expect(all).toHaveLength(2);
      // Sorted by lastAccessedAt desc
      expect(all[0].sessionId).toBe('s2');
      expect(all[1].sessionId).toBe('s1');
    });
  });

  describe('updateEntry', () => {
    it('returns null when entry does not exist', () => {
      const registry = new SessionRegistry();
      const result = registry.updateEntry('/no', 'nope', { title: 'x' });
      expect(result).toBeNull();
    });

    it('merges partial updates into existing entry', () => {
      const registry = new SessionRegistry();
      registry.upsertEntry(makeEntry());

      const result = registry.updateEntry('/home/user/project-a', 'sess-1', {
        title: 'New title',
        archived: true,
      });

      expect(result).not.toBeNull();
      expect(result!.title).toBe('New title');
      expect(result!.archived).toBe(true);
      // Original fields preserved
      expect(result!.firstPrompt).toBe('hello');
      expect(result!.createdAt).toBe(1000);
    });

    it('persists partial updates to disk', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry();
      registry.upsertEntry(entry);

      registry.updateEntry(entry.cwd, entry.sessionId, { title: 'Persisted' });

      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const filePath = join(tempDir, encodedCwd, `${entry.sessionId}.json`);
      const onDisk = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(onDisk.title).toBe('Persisted');
    });
  });

  describe('deleteEntry', () => {
    it('returns false for a non-existent entry', () => {
      const registry = new SessionRegistry();
      expect(registry.deleteEntry('/nope', 'nope')).toBe(false);
    });

    it('removes entry from memory and disk', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry();
      registry.upsertEntry(entry);

      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const filePath = join(tempDir, encodedCwd, `${entry.sessionId}.json`);
      expect(existsSync(filePath)).toBe(true);

      const result = registry.deleteEntry(entry.cwd, entry.sessionId);
      expect(result).toBe(true);
      expect(registry.getEntry(entry.cwd, entry.sessionId)).toBeUndefined();
      expect(existsSync(filePath)).toBe(false);
    });

    it('cleans up the project map when last entry is deleted', () => {
      const registry = new SessionRegistry();
      registry.upsertEntry(makeEntry());

      registry.deleteEntry('/home/user/project-a', 'sess-1');
      expect(registry.getEntriesForProject('/home/user/project-a')).toEqual([]);
    });

    it('does not affect other sessions in the same project', () => {
      const registry = new SessionRegistry();
      registry.upsertEntry(makeEntry({ sessionId: 'sess-1' }));
      registry.upsertEntry(makeEntry({ sessionId: 'sess-2' }));

      registry.deleteEntry('/home/user/project-a', 'sess-1');
      expect(registry.getEntriesForProject('/home/user/project-a')).toHaveLength(1);
      expect(registry.getEntry('/home/user/project-a', 'sess-2')).toBeDefined();
    });
  });

  describe('loadAll (persistence round-trip)', () => {
    it('loads entries written by a previous registry instance', () => {
      const reg1 = new SessionRegistry();
      reg1.upsertEntry(makeEntry({ cwd: '/proj-a', sessionId: 's1', title: 'First' }));
      reg1.upsertEntry(makeEntry({ cwd: '/proj-a', sessionId: 's2', title: 'Second' }));
      reg1.upsertEntry(makeEntry({ cwd: '/proj-b', sessionId: 's3', title: 'Third' }));

      // New instance, load from disk
      const reg2 = new SessionRegistry();
      reg2.loadAll();

      expect(reg2.getEntry('/proj-a', 's1')?.title).toBe('First');
      expect(reg2.getEntry('/proj-a', 's2')?.title).toBe('Second');
      expect(reg2.getEntry('/proj-b', 's3')?.title).toBe('Third');
      expect(reg2.getEntriesForProject('/proj-a')).toHaveLength(2);
    });

    it('handles empty registry directory gracefully', () => {
      const registry = new SessionRegistry();
      // loadAll on empty tempDir should not throw
      registry.loadAll();
      expect(registry.getEntriesForProject(undefined)).toEqual([]);
    });

    it('handles non-existent registry directory gracefully', () => {
      // Point to a dir that does not exist
      const original = tempDir;
      tempDir = join(original, 'does-not-exist');
      const registry = new SessionRegistry();
      registry.loadAll();
      expect(registry.getEntriesForProject(undefined)).toEqual([]);
      tempDir = original;
    });

    it('skips malformed JSON files', () => {
      const registry = new SessionRegistry();
      // Write a valid entry
      registry.upsertEntry(makeEntry({ cwd: '/proj', sessionId: 'good' }));

      // Write a malformed file in the same project dir
      const { writeFileSync } = require('fs');
      const encodedCwd = '/proj'.replace(/\//g, '-');
      const badFile = join(tempDir, encodedCwd, 'bad.json');
      writeFileSync(badFile, 'not valid json{{{');

      const reg2 = new SessionRegistry();
      reg2.loadAll();
      // Should load the good entry and skip the bad one
      expect(reg2.getEntriesForProject('/proj')).toHaveLength(1);
      expect(reg2.getEntry('/proj', 'good')).toBeDefined();
    });

    it('skips entries missing sessionId or cwd', () => {
      const { writeFileSync, mkdirSync } = require('fs');
      const projDir = join(tempDir, '-proj');
      mkdirSync(projDir, { recursive: true });

      // Entry missing sessionId
      writeFileSync(
        join(projDir, 'no-sid.json'),
        JSON.stringify({ cwd: '/proj', createdAt: 1, lastAccessedAt: 1 }),
      );
      // Entry missing cwd
      writeFileSync(
        join(projDir, 'no-cwd.json'),
        JSON.stringify({ sessionId: 'x', createdAt: 1, lastAccessedAt: 1 }),
      );

      const registry = new SessionRegistry();
      registry.loadAll();
      expect(registry.getEntriesForProject('/proj')).toEqual([]);
    });
  });

  describe('archive storage routing', () => {
    it('upsertEntry with archived: true writes under archived/ subtree, not active', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry({ archived: true });
      registry.upsertEntry(entry);

      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const activePath = join(tempDir, encodedCwd, `${entry.sessionId}.json`);
      const archivedPath = join(tempDir, 'archived', encodedCwd, `${entry.sessionId}.json`);

      expect(existsSync(archivedPath)).toBe(true);
      expect(existsSync(activePath)).toBe(false);

      const onDisk = JSON.parse(readFileSync(archivedPath, 'utf-8'));
      expect(onDisk).toEqual(entry);
    });

    it('upsertEntry with archived: true does not add entry to in-memory map', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry({ archived: true });
      registry.upsertEntry(entry);

      expect(registry.getEntry(entry.cwd, entry.sessionId)).toBeUndefined();
      expect(registry.getEntriesForProject(entry.cwd)).toEqual([]);
      expect(registry.findBySessionId(entry.sessionId)).toBeUndefined();
    });

    it('upsertEntry with archived: false writes to active subtree and is visible in memory', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry({ archived: false });
      registry.upsertEntry(entry);

      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const activePath = join(tempDir, encodedCwd, `${entry.sessionId}.json`);
      const archivedPath = join(tempDir, 'archived', encodedCwd, `${entry.sessionId}.json`);

      expect(existsSync(activePath)).toBe(true);
      expect(existsSync(archivedPath)).toBe(false);

      expect(registry.getEntry(entry.cwd, entry.sessionId)).toEqual(entry);
      expect(registry.getEntriesForProject(entry.cwd)).toHaveLength(1);
      expect(registry.findBySessionId(entry.sessionId)).toEqual(entry);
    });

    it('upsertEntry with archived omitted writes to active subtree and is visible in memory', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry();
      registry.upsertEntry(entry);

      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const activePath = join(tempDir, encodedCwd, `${entry.sessionId}.json`);
      const archivedPath = join(tempDir, 'archived', encodedCwd, `${entry.sessionId}.json`);

      expect(existsSync(activePath)).toBe(true);
      expect(existsSync(archivedPath)).toBe(false);
      expect(registry.findBySessionId(entry.sessionId)).toEqual(entry);
    });

    it('transitions active -> archived: removes active file, creates archived file, drops from memory', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry();
      registry.upsertEntry(entry);

      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const activePath = join(tempDir, encodedCwd, `${entry.sessionId}.json`);
      const archivedPath = join(tempDir, 'archived', encodedCwd, `${entry.sessionId}.json`);

      expect(existsSync(activePath)).toBe(true);
      expect(existsSync(archivedPath)).toBe(false);

      registry.upsertEntry({ ...entry, archived: true });

      expect(existsSync(activePath)).toBe(false);
      expect(existsSync(archivedPath)).toBe(true);
      expect(registry.getEntry(entry.cwd, entry.sessionId)).toBeUndefined();
      expect(registry.findBySessionId(entry.sessionId)).toBeUndefined();
    });

    it('transitions archived -> active: removes archived file, creates active file, adds to memory', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry({ archived: true });
      registry.upsertEntry(entry);

      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const activePath = join(tempDir, encodedCwd, `${entry.sessionId}.json`);
      const archivedPath = join(tempDir, 'archived', encodedCwd, `${entry.sessionId}.json`);

      expect(existsSync(archivedPath)).toBe(true);
      expect(existsSync(activePath)).toBe(false);

      registry.upsertEntry({ ...entry, archived: false });

      expect(existsSync(archivedPath)).toBe(false);
      expect(existsSync(activePath)).toBe(true);
      const loaded = registry.getEntry(entry.cwd, entry.sessionId);
      expect(loaded).toBeDefined();
      expect(loaded!.archived).toBe(false);
    });
  });

  describe('readArchivedEntry', () => {
    it('returns undefined when no archived file exists', () => {
      const registry = new SessionRegistry();
      expect(registry.readArchivedEntry('/home/user/project-a', 'sess-1')).toBeUndefined();
    });

    it('returns the entry when an archived file exists', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry({ archived: true, title: 'Archived one' });
      registry.upsertEntry(entry);

      const result = registry.readArchivedEntry(entry.cwd, entry.sessionId);
      expect(result).toEqual(entry);
    });

    it('does not return active entries', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry();
      registry.upsertEntry(entry);

      expect(registry.readArchivedEntry(entry.cwd, entry.sessionId)).toBeUndefined();
    });
  });

  describe('listArchivedEntries', () => {
    it('returns [] when archived subtree is missing', () => {
      const registry = new SessionRegistry();
      expect(registry.listArchivedEntries()).toEqual([]);
      expect(registry.listArchivedEntries('/home/user/project-a')).toEqual([]);
    });

    it('returns [] when archived subtree has no entries for given cwd', () => {
      const registry = new SessionRegistry();
      // Seed an archived entry for a different project
      registry.upsertEntry(makeEntry({ cwd: '/proj-a', sessionId: 's1', archived: true }));
      expect(registry.listArchivedEntries('/proj-b')).toEqual([]);
    });

    it('returns only archived entries, sorted by lastAccessedAt desc', () => {
      const registry = new SessionRegistry();

      // Active entries (should be excluded)
      registry.upsertEntry(
        makeEntry({ cwd: '/proj-a', sessionId: 'active-1', lastAccessedAt: 9000 }),
      );
      registry.upsertEntry(
        makeEntry({ cwd: '/proj-b', sessionId: 'active-2', lastAccessedAt: 9500 }),
      );

      // Archived entries
      registry.upsertEntry(
        makeEntry({
          cwd: '/proj-a',
          sessionId: 'arch-old',
          archived: true,
          lastAccessedAt: 1000,
        }),
      );
      registry.upsertEntry(
        makeEntry({
          cwd: '/proj-b',
          sessionId: 'arch-new',
          archived: true,
          lastAccessedAt: 3000,
        }),
      );
      registry.upsertEntry(
        makeEntry({
          cwd: '/proj-a',
          sessionId: 'arch-mid',
          archived: true,
          lastAccessedAt: 2000,
        }),
      );

      const all = registry.listArchivedEntries();
      expect(all.map((e) => e.sessionId)).toEqual(['arch-new', 'arch-mid', 'arch-old']);
      // None of the active ones
      expect(all.some((e) => e.sessionId.startsWith('active-'))).toBe(false);
    });

    it('filters to the given cwd when provided', () => {
      const registry = new SessionRegistry();
      registry.upsertEntry(
        makeEntry({
          cwd: '/proj-a',
          sessionId: 'a1',
          archived: true,
          lastAccessedAt: 1000,
        }),
      );
      registry.upsertEntry(
        makeEntry({
          cwd: '/proj-a',
          sessionId: 'a2',
          archived: true,
          lastAccessedAt: 2000,
        }),
      );
      registry.upsertEntry(
        makeEntry({
          cwd: '/proj-b',
          sessionId: 'b1',
          archived: true,
          lastAccessedAt: 3000,
        }),
      );

      const forA = registry.listArchivedEntries('/proj-a');
      expect(forA.map((e) => e.sessionId)).toEqual(['a2', 'a1']);

      const forB = registry.listArchivedEntries('/proj-b');
      expect(forB.map((e) => e.sessionId)).toEqual(['b1']);
    });

    it('returns archived entries across all projects when cwd is omitted', () => {
      const registry = new SessionRegistry();
      registry.upsertEntry(
        makeEntry({
          cwd: '/proj-a',
          sessionId: 'a1',
          archived: true,
          lastAccessedAt: 1000,
        }),
      );
      registry.upsertEntry(
        makeEntry({
          cwd: '/proj-b',
          sessionId: 'b1',
          archived: true,
          lastAccessedAt: 2000,
        }),
      );

      const all = registry.listArchivedEntries();
      expect(all).toHaveLength(2);
      expect(all[0].sessionId).toBe('b1');
      expect(all[1].sessionId).toBe('a1');
    });
  });

  describe('listArchivedEntriesPage', () => {
    // Helper: seed an archived entry then pin its mtime so ordering is deterministic.
    function seedArchived(
      registry: InstanceType<typeof SessionRegistry>,
      cwd: string,
      sessionId: string,
      mtimeSeconds: number,
    ) {
      registry.upsertEntry(makeEntry({ cwd, sessionId, archived: true }));
      const encodedCwd = cwd.replace(/\//g, '-');
      const filePath = join(tempDir, 'archived', encodedCwd, `${sessionId}.json`);
      utimesSync(filePath, mtimeSeconds, mtimeSeconds);
    }

    it('returns {entries:[], total:0} when archived subtree is missing', () => {
      const registry = new SessionRegistry();
      expect(registry.listArchivedEntriesPage('/proj-a', 0, 20)).toEqual({ entries: [], total: 0 });
      expect(registry.listArchivedEntriesPage(undefined, 0, 20)).toEqual({ entries: [], total: 0 });
    });

    it('returns entries sorted by file mtime desc (newest archived first)', () => {
      const registry = new SessionRegistry();
      seedArchived(registry, '/proj-a', 'oldest', 1_000);
      seedArchived(registry, '/proj-a', 'middle', 2_000);
      seedArchived(registry, '/proj-a', 'newest', 3_000);

      const { entries, total } = registry.listArchivedEntriesPage('/proj-a', 0, 20);
      expect(total).toBe(3);
      expect(entries.map((e) => e.sessionId)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('paginates correctly: offset+limit returns a slice; total counts all', () => {
      const registry = new SessionRegistry();
      for (let i = 0; i < 5; i++) {
        seedArchived(registry, '/proj-a', `s${i}`, 1_000 + i);
      }

      const page1 = registry.listArchivedEntriesPage('/proj-a', 0, 2);
      expect(page1.total).toBe(5);
      expect(page1.entries.map((e) => e.sessionId)).toEqual(['s4', 's3']);

      const page2 = registry.listArchivedEntriesPage('/proj-a', 2, 2);
      expect(page2.total).toBe(5);
      expect(page2.entries.map((e) => e.sessionId)).toEqual(['s2', 's1']);

      const page3 = registry.listArchivedEntriesPage('/proj-a', 4, 2);
      expect(page3.total).toBe(5);
      expect(page3.entries.map((e) => e.sessionId)).toEqual(['s0']);
    });

    it('returns empty entries but correct total when offset exceeds size', () => {
      const registry = new SessionRegistry();
      seedArchived(registry, '/proj-a', 's1', 1_000);

      const result = registry.listArchivedEntriesPage('/proj-a', 100, 20);
      expect(result.total).toBe(1);
      expect(result.entries).toEqual([]);
    });

    it('filters by cwd when provided', () => {
      const registry = new SessionRegistry();
      seedArchived(registry, '/proj-a', 'a1', 1_000);
      seedArchived(registry, '/proj-a', 'a2', 2_000);
      seedArchived(registry, '/proj-b', 'b1', 3_000);

      const forA = registry.listArchivedEntriesPage('/proj-a', 0, 20);
      expect(forA.total).toBe(2);
      expect(forA.entries.map((e) => e.sessionId)).toEqual(['a2', 'a1']);

      const forB = registry.listArchivedEntriesPage('/proj-b', 0, 20);
      expect(forB.total).toBe(1);
      expect(forB.entries.map((e) => e.sessionId)).toEqual(['b1']);
    });

    it('merges across all projects when cwd is undefined', () => {
      const registry = new SessionRegistry();
      seedArchived(registry, '/proj-a', 'a-old', 1_000);
      seedArchived(registry, '/proj-b', 'b-new', 3_000);
      seedArchived(registry, '/proj-a', 'a-new', 2_000);

      const all = registry.listArchivedEntriesPage(undefined, 0, 20);
      expect(all.total).toBe(3);
      expect(all.entries.map((e) => e.sessionId)).toEqual(['b-new', 'a-new', 'a-old']);
    });

    it('returns total=0 for a cwd that has no archived entries', () => {
      const registry = new SessionRegistry();
      seedArchived(registry, '/proj-a', 's1', 1_000);

      const result = registry.listArchivedEntriesPage('/proj-b', 0, 20);
      expect(result).toEqual({ entries: [], total: 0 });
    });

    it('does not include active (non-archived) entries', () => {
      const registry = new SessionRegistry();
      registry.upsertEntry(makeEntry({ cwd: '/proj-a', sessionId: 'active-1' }));
      seedArchived(registry, '/proj-a', 'archived-1', 1_000);

      const result = registry.listArchivedEntriesPage('/proj-a', 0, 20);
      expect(result.total).toBe(1);
      expect(result.entries[0].sessionId).toBe('archived-1');
    });

    it('clamps negative offset and limit to zero', () => {
      const registry = new SessionRegistry();
      seedArchived(registry, '/proj-a', 's1', 1_000);

      const neg = registry.listArchivedEntriesPage('/proj-a', -5, -10);
      expect(neg.total).toBe(1);
      expect(neg.entries).toEqual([]);
    });
  });

  describe('updateEntry — archive transitions', () => {
    it('finds and updates entries that live only in the archived subtree', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry({ archived: true });
      registry.upsertEntry(entry);

      const result = registry.updateEntry(entry.cwd, entry.sessionId, { title: 'x' });
      expect(result).not.toBeNull();
      expect(result!.title).toBe('x');
      expect(result!.archived).toBe(true);

      // Still archived on disk, not in memory
      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const archivedPath = join(tempDir, 'archived', encodedCwd, `${entry.sessionId}.json`);
      expect(existsSync(archivedPath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(archivedPath, 'utf-8'));
      expect(onDisk.title).toBe('x');
      expect(onDisk.archived).toBe(true);
      expect(registry.getEntry(entry.cwd, entry.sessionId)).toBeUndefined();
    });

    it('flipping archived true -> false moves file from archived to active subtree', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry({ archived: true });
      registry.upsertEntry(entry);

      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const activePath = join(tempDir, encodedCwd, `${entry.sessionId}.json`);
      const archivedPath = join(tempDir, 'archived', encodedCwd, `${entry.sessionId}.json`);

      const result = registry.updateEntry(entry.cwd, entry.sessionId, { archived: false });
      expect(result).not.toBeNull();
      expect(result!.archived).toBe(false);

      expect(existsSync(archivedPath)).toBe(false);
      expect(existsSync(activePath)).toBe(true);
      const fromMem = registry.getEntry(entry.cwd, entry.sessionId);
      expect(fromMem).toBeDefined();
      expect(fromMem!.archived).toBe(false);
    });

    it('flipping archived false -> true moves file from active to archived subtree', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry();
      registry.upsertEntry(entry);

      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const activePath = join(tempDir, encodedCwd, `${entry.sessionId}.json`);
      const archivedPath = join(tempDir, 'archived', encodedCwd, `${entry.sessionId}.json`);

      const result = registry.updateEntry(entry.cwd, entry.sessionId, { archived: true });
      expect(result).not.toBeNull();
      expect(result!.archived).toBe(true);

      expect(existsSync(activePath)).toBe(false);
      expect(existsSync(archivedPath)).toBe(true);
      expect(registry.getEntry(entry.cwd, entry.sessionId)).toBeUndefined();
    });

    it('returns null when the entry exists in neither subtree', () => {
      const registry = new SessionRegistry();
      const result = registry.updateEntry('/nope', 'nope', { title: 'x' });
      expect(result).toBeNull();
    });
  });

  describe('deleteEntry — both subtrees', () => {
    it('removes an archived entry and returns true', () => {
      const registry = new SessionRegistry();
      const entry = makeEntry({ archived: true });
      registry.upsertEntry(entry);

      const encodedCwd = entry.cwd.replace(/\//g, '-');
      const archivedPath = join(tempDir, 'archived', encodedCwd, `${entry.sessionId}.json`);
      expect(existsSync(archivedPath)).toBe(true);

      const result = registry.deleteEntry(entry.cwd, entry.sessionId);
      expect(result).toBe(true);
      expect(existsSync(archivedPath)).toBe(false);
      expect(registry.readArchivedEntry(entry.cwd, entry.sessionId)).toBeUndefined();
    });

    it('returns false when entry exists in neither subtree', () => {
      const registry = new SessionRegistry();
      expect(registry.deleteEntry('/no', 'nothing')).toBe(false);
    });
  });

  describe('loadAll — legacy migration', () => {
    it('migrates legacy archived entry found in active subtree to archived subtree', () => {
      const { writeFileSync, mkdirSync } = require('fs');
      const cwd = '/home/user/legacy-proj';
      const encodedCwd = cwd.replace(/\//g, '-');
      const projDir = join(tempDir, encodedCwd);
      mkdirSync(projDir, { recursive: true });

      const legacyEntry = makeEntry({
        cwd,
        sessionId: 'legacy-arch',
        archived: true,
        title: 'Legacy archived',
      });
      const legacyPath = join(projDir, `${legacyEntry.sessionId}.json`);
      writeFileSync(legacyPath, JSON.stringify(legacyEntry));

      const registry = new SessionRegistry();
      registry.loadAll();

      // Active file removed
      expect(existsSync(legacyPath)).toBe(false);
      // Archived file exists with same contents
      const archivedPath = join(
        tempDir,
        'archived',
        encodedCwd,
        `${legacyEntry.sessionId}.json`,
      );
      expect(existsSync(archivedPath)).toBe(true);
      const onDisk = JSON.parse(readFileSync(archivedPath, 'utf-8'));
      expect(onDisk).toEqual(legacyEntry);

      // Not in memory
      expect(registry.getEntry(cwd, legacyEntry.sessionId)).toBeUndefined();
      // But readable via readArchivedEntry
      expect(registry.readArchivedEntry(cwd, legacyEntry.sessionId)).toEqual(legacyEntry);
    });

    it('does not treat the archived/ directory as a project dir when loading active entries', () => {
      // Pre-seed archived entries on disk by using upsertEntry on a first registry.
      const seed = new SessionRegistry();
      seed.upsertEntry(
        makeEntry({
          cwd: '/proj-a',
          sessionId: 'arch-1',
          archived: true,
          title: 'Archived A',
        }),
      );
      seed.upsertEntry(makeEntry({ cwd: '/proj-a', sessionId: 'active-1', title: 'Active A' }));

      // Archived subtree exists at tempDir/archived
      expect(existsSync(join(tempDir, 'archived'))).toBe(true);

      const registry = new SessionRegistry();
      registry.loadAll();

      // Only the active entry should be in memory
      const all = registry.getEntriesForProject(undefined);
      expect(all.map((e) => e.sessionId)).toEqual(['active-1']);

      // And no phantom entry with an "archived" cwd was created
      expect(registry.getEntriesForProject('/archived')).toEqual([]);
      // Double-check: no entry whose cwd comes from a decoded "archived" path
      for (const e of all) {
        expect(e.cwd).not.toMatch(/archived/);
      }
    });

    it('loads mixed: active, pre-archived, and legacy-archived correctly', () => {
      const { writeFileSync, mkdirSync } = require('fs');

      // Seed via an initial registry: creates one active + one pre-archived file.
      const seed = new SessionRegistry();
      seed.upsertEntry(
        makeEntry({
          cwd: '/proj-a',
          sessionId: 'active-1',
          title: 'Active',
          lastAccessedAt: 5000,
        }),
      );
      seed.upsertEntry(
        makeEntry({
          cwd: '/proj-a',
          sessionId: 'pre-arch',
          archived: true,
          title: 'Pre-archived',
          lastAccessedAt: 6000,
        }),
      );

      // Write a legacy entry directly under active subtree with archived: true.
      const legacyCwd = '/proj-b';
      const legacyEncoded = legacyCwd.replace(/\//g, '-');
      const legacyProjDir = join(tempDir, legacyEncoded);
      mkdirSync(legacyProjDir, { recursive: true });
      const legacy = makeEntry({
        cwd: legacyCwd,
        sessionId: 'legacy',
        archived: true,
        title: 'Legacy',
        lastAccessedAt: 7000,
      });
      const legacyActivePath = join(legacyProjDir, `${legacy.sessionId}.json`);
      writeFileSync(legacyActivePath, JSON.stringify(legacy));

      // Pre-archived file should already be in archived subtree (from seed upsert).
      const preArchivedPath = join(tempDir, 'archived', '-proj-a', 'pre-arch.json');
      expect(existsSync(preArchivedPath)).toBe(true);
      const preArchivedBefore = readFileSync(preArchivedPath, 'utf-8');

      const registry = new SessionRegistry();
      registry.loadAll();

      // Only true active entries in memory
      const inMem = registry.getEntriesForProject(undefined);
      expect(inMem.map((e) => e.sessionId)).toEqual(['active-1']);

      // Legacy migrated: active file gone, archived file exists
      expect(existsSync(legacyActivePath)).toBe(false);
      const legacyArchivedPath = join(
        tempDir,
        'archived',
        legacyEncoded,
        `${legacy.sessionId}.json`,
      );
      expect(existsSync(legacyArchivedPath)).toBe(true);
      expect(registry.readArchivedEntry(legacyCwd, legacy.sessionId)).toEqual(legacy);

      // Pre-existing archived file untouched (same bytes)
      expect(existsSync(preArchivedPath)).toBe(true);
      expect(readFileSync(preArchivedPath, 'utf-8')).toBe(preArchivedBefore);

      // listArchivedEntries returns both archived ones, sorted desc by lastAccessedAt
      const archived = registry.listArchivedEntries();
      expect(archived.map((e) => e.sessionId)).toEqual(['legacy', 'pre-arch']);
    });
  });
});
