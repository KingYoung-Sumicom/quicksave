// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setQuicksaveDir, getArtifactsDir } from '../service/singleton.js';
import {
  loadArtifactBySession,
  listSessionArtifacts,
  publishMarkdownArtifact,
} from './artifactStore.js';

describe('artifactStore', () => {
  let quicksaveDir: string;
  let cwd: string;

  beforeEach(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    quicksaveDir = join(tmpdir(), `qs-artifacts-${suffix}`);
    cwd = join(tmpdir(), `qs-artifacts-project-${suffix}`);
    await mkdir(quicksaveDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    setQuicksaveDir(quicksaveDir);
  });

  afterEach(async () => {
    await rm(quicksaveDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('publishes markdown metadata and fetches bytes by session id', async () => {
    await writeFile(join(cwd, 'report.md'), '# Report\n\nhello\n');

    const meta = await publishMarkdownArtifact({
      sessionId: 'sess-1',
      cwd,
      sourcePath: 'report.md',
      title: 'Report',
    });

    expect(meta.refKind).toBe('artifact');
    expect(meta.title).toBe('Report');
    expect(meta.size).toBe(Buffer.byteLength('# Report\n\nhello\n'));
    expect(getArtifactsDir()).toBe(join(quicksaveDir, 'state', 'artifacts'));

    const loaded = await loadArtifactBySession('sess-1', meta.artifactId);
    expect(loaded).not.toBeNull();
    expect(Buffer.from(loaded!.contentBase64, 'base64').toString('utf8')).toBe('# Report\n\nhello\n');
  });

  it('rejects source files outside the project directory', async () => {
    const outside = join(tmpdir(), `outside-${Date.now()}.md`);
    await writeFile(outside, '# Outside\n');

    await expect(publishMarkdownArtifact({
      sessionId: 'sess-1',
      cwd,
      sourcePath: outside,
    })).rejects.toThrow(/inside the project directory/);

    await rm(outside, { force: true });
  });

  it('lists metadata for a session', async () => {
    await writeFile(join(cwd, 'a.md'), '# A\n');
    await writeFile(join(cwd, 'b.markdown'), '# B\n');

    await publishMarkdownArtifact({ sessionId: 'sess-1', cwd, sourcePath: 'a.md', title: 'A' });
    await publishMarkdownArtifact({ sessionId: 'sess-1', cwd, sourcePath: 'b.markdown', title: 'B' });

    expect((await listSessionArtifacts(cwd, 'sess-1')).map((m) => m.title).sort()).toEqual(['A', 'B']);
  });
});
