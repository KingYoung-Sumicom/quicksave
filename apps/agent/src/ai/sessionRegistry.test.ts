import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs';
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
});
