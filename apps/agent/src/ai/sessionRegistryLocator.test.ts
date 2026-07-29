// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findRegistryPathByCorr,
  findRegistryPathBySessionId,
} from './sessionRegistryLocator.js';

describe('findRegistryPathByCorr', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'corr-locator-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, entry: Record<string, unknown>) =>
    writeFileSync(join(dir, name), JSON.stringify(entry));

  it('returns the file whose mcpCorrId matches', () => {
    write('s1.json', { sessionId: 's1', mcpCorrId: 'corr-A' });
    write('s2.json', { sessionId: 's2', mcpCorrId: 'corr-B' });
    expect(findRegistryPathByCorr(dir, 'corr-B')).toBe(join(dir, 's2.json'));
  });

  it('returns null when no entry matches', () => {
    write('s1.json', { sessionId: 's1', mcpCorrId: 'corr-A' });
    expect(findRegistryPathByCorr(dir, 'corr-missing')).toBeNull();
  });

  it('returns null when the directory does not exist', () => {
    expect(findRegistryPathByCorr(join(dir, 'nope'), 'corr-A')).toBeNull();
  });

  it('ignores non-json files', () => {
    writeFileSync(join(dir, 'notes.txt'), 'mcpCorrId corr-A');
    write('s1.json', { sessionId: 's1', mcpCorrId: 'corr-A' });
    expect(findRegistryPathByCorr(dir, 'corr-A')).toBe(join(dir, 's1.json'));
  });

  it('skips unparseable / partially-written files and keeps scanning', () => {
    writeFileSync(join(dir, 's1.json'), '{ not valid json');
    write('s2.json', { sessionId: 's2', mcpCorrId: 'corr-A' });
    expect(findRegistryPathByCorr(dir, 'corr-A')).toBe(join(dir, 's2.json'));
  });

  it('does not match entries lacking mcpCorrId', () => {
    write('s1.json', { sessionId: 's1' });
    expect(findRegistryPathByCorr(dir, 'corr-A')).toBeNull();
  });

  it('is exact: a matching corr wins regardless of file recency / ordering', () => {
    // Multiple concurrent sessions in the same cwd — the right one is found by
    // corr, not by being newest.
    mkdirSync(join(dir, 'sub'), { recursive: true }); // a stray dir is ignored
    write('older.json', { sessionId: 'old', mcpCorrId: 'corr-mine' });
    write('newer.json', { sessionId: 'new', mcpCorrId: 'corr-other' });
    expect(findRegistryPathByCorr(dir, 'corr-mine')).toBe(join(dir, 'older.json'));
  });
});

describe('findRegistryPathBySessionId', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'session-locator-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the exact session across encoded project directories', () => {
    const projectA = join(root, '-workspace-a');
    const projectB = join(root, '-workspace-b');
    mkdirSync(projectA);
    mkdirSync(projectB);
    writeFileSync(join(projectA, 'ses_other.json'), JSON.stringify({ sessionId: 'ses_other' }));
    writeFileSync(join(projectB, 'ses_target.json'), JSON.stringify({ sessionId: 'ses_target' }));

    expect(findRegistryPathBySessionId(root, 'ses_target'))
      .toBe(join(projectB, 'ses_target.json'));
  });

  it('rejects path-like ids and ignores archived entries', () => {
    const archivedProject = join(root, 'archived', '-workspace-a');
    mkdirSync(archivedProject, { recursive: true });
    writeFileSync(join(archivedProject, 'ses_old.json'), JSON.stringify({ sessionId: 'ses_old' }));

    expect(findRegistryPathBySessionId(root, '../escape')).toBeNull();
    expect(findRegistryPathBySessionId(root, 'ses_old')).toBeNull();
  });
});
