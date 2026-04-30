// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitOperations } from './operations.js';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { simpleGit } from 'simple-git';

describe('GitOperations', () => {
  let testRepoPath: string;
  let gitOps: GitOperations;
  let defaultBranch: string;

  beforeEach(async () => {
    // Create temporary test repo
    testRepoPath = join(tmpdir(), `quicksave-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testRepoPath, { recursive: true });

    // Initialize git repo
    const git = simpleGit(testRepoPath);
    await git.init();
    await git.addConfig('user.email', 'test@test.com');
    await git.addConfig('user.name', 'Test User');

    // Create initial commit
    await writeFile(join(testRepoPath, 'README.md'), '# Test Repo\n');
    await git.add('README.md');
    await git.commit('Initial commit');

    // Get the default branch name (could be 'main' or 'master' depending on git config)
    const status = await git.status();
    defaultBranch = status.current || 'main';

    gitOps = new GitOperations(testRepoPath);
  });

  afterEach(async () => {
    // Cleanup
    try {
      await rm(testRepoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('isValidRepo', () => {
    it('should return true for valid git repo', async () => {
      const isValid = await gitOps.isValidRepo();
      expect(isValid).toBe(true);
    });

    it('should return false for non-git directory', async () => {
      const nonGitPath = join(tmpdir(), `non-git-${Date.now()}`);
      await mkdir(nonGitPath, { recursive: true });

      const ops = new GitOperations(nonGitPath);
      const isValid = await ops.isValidRepo();
      expect(isValid).toBe(false);

      await rm(nonGitPath, { recursive: true, force: true });
    });
  });

  describe('getStatus', () => {
    it('should return clean status for unchanged repo', async () => {
      const status = await gitOps.getStatus();

      expect(status.branch).toBe(defaultBranch);
      expect(status.staged).toHaveLength(0);
      expect(status.unstaged).toHaveLength(0);
      expect(status.untracked).toHaveLength(0);
    });

    it('should detect untracked files', async () => {
      await writeFile(join(testRepoPath, 'newfile.txt'), 'content');

      const status = await gitOps.getStatus();

      expect(status.untracked).toContain('newfile.txt');
    });

    it('should detect modified files', async () => {
      await writeFile(join(testRepoPath, 'README.md'), '# Modified\n');

      const status = await gitOps.getStatus();

      expect(status.unstaged).toHaveLength(1);
      expect(status.unstaged[0].path).toBe('README.md');
      expect(status.unstaged[0].status).toBe('modified');
    });

    it('should detect staged files', async () => {
      await writeFile(join(testRepoPath, 'README.md'), '# Modified\n');
      await simpleGit(testRepoPath).add('README.md');

      const status = await gitOps.getStatus();

      expect(status.staged).toHaveLength(1);
      expect(status.staged[0].path).toBe('README.md');
    });

    it('should detect new staged files as added', async () => {
      await writeFile(join(testRepoPath, 'newfile.txt'), 'content');
      await simpleGit(testRepoPath).add('newfile.txt');

      const status = await gitOps.getStatus();

      expect(status.staged).toHaveLength(1);
      expect(status.staged[0].path).toBe('newfile.txt');
      expect(status.staged[0].status).toBe('added');
    });
  });

  describe('stage', () => {
    it('should stage a single file', async () => {
      await writeFile(join(testRepoPath, 'file.txt'), 'content');

      await gitOps.stage(['file.txt']);

      const status = await gitOps.getStatus();
      expect(status.staged.some(f => f.path === 'file.txt')).toBe(true);
      expect(status.untracked).not.toContain('file.txt');
    });

    it('should stage multiple files', async () => {
      await writeFile(join(testRepoPath, 'file1.txt'), 'content1');
      await writeFile(join(testRepoPath, 'file2.txt'), 'content2');

      await gitOps.stage(['file1.txt', 'file2.txt']);

      const status = await gitOps.getStatus();
      expect(status.staged).toHaveLength(2);
    });
  });

  describe('unstage', () => {
    it('should unstage a staged file', async () => {
      await writeFile(join(testRepoPath, 'file.txt'), 'content');
      await simpleGit(testRepoPath).add('file.txt');

      await gitOps.unstage(['file.txt']);

      const status = await gitOps.getStatus();
      expect(status.staged).toHaveLength(0);
      expect(status.untracked).toContain('file.txt');
    });
  });

  describe('commit', () => {
    it('should create a commit with message', async () => {
      await writeFile(join(testRepoPath, 'file.txt'), 'content');
      await simpleGit(testRepoPath).add('file.txt');

      const hash = await gitOps.commit('Test commit');

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');

      const log = await gitOps.getLog(1);
      expect(log[0].message).toBe('Test commit');
    });

    it('should create a commit with message and description', async () => {
      await writeFile(join(testRepoPath, 'file.txt'), 'content');
      await simpleGit(testRepoPath).add('file.txt');

      await gitOps.commit('Title', 'Description body');

      const log = await gitOps.getLog(1);
      expect(log[0].message).toContain('Title');
    });
  });

  describe('getLog', () => {
    it('should return commit history', async () => {
      const log = await gitOps.getLog();

      expect(log).toHaveLength(1);
      expect(log[0].message).toBe('Initial commit');
      expect(log[0].author).toBe('Test User');
      expect(log[0].email).toBe('test@test.com');
    });

    it('should return limited commits', async () => {
      // Create more commits
      for (let i = 0; i < 5; i++) {
        await writeFile(join(testRepoPath, `file${i}.txt`), `content${i}`);
        await simpleGit(testRepoPath).add(`file${i}.txt`);
        await simpleGit(testRepoPath).commit(`Commit ${i}`);
      }

      const log = await gitOps.getLog(3);
      expect(log).toHaveLength(3);
    });

    it('should have proper commit structure', async () => {
      const log = await gitOps.getLog(1);
      const commit = log[0];

      expect(commit.hash).toMatch(/^[a-f0-9]{40}$/);
      expect(commit.shortHash).toHaveLength(7);
      expect(commit.shortHash).toBe(commit.hash.slice(0, 7));
    });
  });

  describe('getBranches', () => {
    it('should return current branch', async () => {
      const { branches, current } = await gitOps.getBranches();

      expect(current).toBe(defaultBranch);
      expect(branches.some(b => b.name === defaultBranch && b.current)).toBe(true);
    });

    it('should list multiple branches', async () => {
      await simpleGit(testRepoPath).checkoutLocalBranch('feature');

      const { branches } = await gitOps.getBranches();

      expect(branches.some(b => b.name === defaultBranch)).toBe(true);
      expect(branches.some(b => b.name === 'feature')).toBe(true);
    });
  });

  describe('checkout', () => {
    it('should checkout existing branch', async () => {
      await simpleGit(testRepoPath).checkoutLocalBranch('feature');

      // Go back to default branch
      await gitOps.checkout(defaultBranch);

      let { current } = await gitOps.getBranches();
      expect(current).toBe(defaultBranch);

      // Now checkout feature again
      await gitOps.checkout('feature');

      ({ current } = await gitOps.getBranches());
      expect(current).toBe('feature');
    });

    it('should create and checkout new branch', async () => {
      await gitOps.checkout('new-branch', true);

      const { current } = await gitOps.getBranches();
      expect(current).toBe('new-branch');
    });
  });

  describe('discard', () => {
    it('should discard changes in modified file', async () => {
      await writeFile(join(testRepoPath, 'README.md'), '# Modified\n');

      let status = await gitOps.getStatus();
      expect(status.unstaged).toHaveLength(1);

      await gitOps.discard(['README.md']);

      status = await gitOps.getStatus();
      expect(status.unstaged).toHaveLength(0);
    });
  });

  describe('untrack', () => {
    it('should remove a tracked file from the index but keep it on disk', async () => {
      await gitOps.untrack(['README.md']);
      const status = await gitOps.getStatus();
      expect(status.untracked).toContain('README.md');
      expect(status.staged.some(f => f.path === 'README.md' && f.status === 'deleted')).toBe(true);
    });

    it('should untrack multiple files', async () => {
      await writeFile(join(testRepoPath, 'tracked.txt'), 'content');
      await simpleGit(testRepoPath).add('tracked.txt');
      await simpleGit(testRepoPath).commit('Add tracked.txt');
      await gitOps.untrack(['README.md', 'tracked.txt']);
      const status = await gitOps.getStatus();
      expect(status.untracked).toContain('README.md');
      expect(status.untracked).toContain('tracked.txt');
    });
  });

  describe('readGitignore', () => {
    it('should return empty string and exists=false when .gitignore does not exist', async () => {
      const result = await gitOps.readGitignore();
      expect(result.content).toBe('');
      expect(result.exists).toBe(false);
    });

    it('should return content and exists=true when .gitignore exists', async () => {
      await writeFile(join(testRepoPath, '.gitignore'), 'node_modules/\n*.log\n');
      const result = await gitOps.readGitignore();
      expect(result.content).toBe('node_modules/\n*.log\n');
      expect(result.exists).toBe(true);
    });
  });

  describe('writeGitignore', () => {
    it('should create .gitignore if it does not exist', async () => {
      await gitOps.writeGitignore('node_modules/\n');
      const content = await readFile(join(testRepoPath, '.gitignore'), 'utf-8');
      expect(content).toBe('node_modules/\n');
    });

    it('should overwrite existing .gitignore content', async () => {
      await writeFile(join(testRepoPath, '.gitignore'), 'old\n');
      await gitOps.writeGitignore('new\n');
      const content = await readFile(join(testRepoPath, '.gitignore'), 'utf-8');
      expect(content).toBe('new\n');
    });
  });

  describe('addToGitignore', () => {
    it('should create .gitignore and add pattern if file does not exist', async () => {
      await gitOps.addToGitignore('node_modules/');
      const content = await readFile(join(testRepoPath, '.gitignore'), 'utf-8');
      expect(content).toBe('node_modules/\n');
    });

    it('should append pattern to existing .gitignore', async () => {
      await writeFile(join(testRepoPath, '.gitignore'), 'node_modules/\n');
      await gitOps.addToGitignore('*.log');
      const content = await readFile(join(testRepoPath, '.gitignore'), 'utf-8');
      expect(content).toBe('node_modules/\n*.log\n');
    });

    it('should ensure newline before appending if missing', async () => {
      await writeFile(join(testRepoPath, '.gitignore'), 'node_modules/');
      await gitOps.addToGitignore('*.log');
      const content = await readFile(join(testRepoPath, '.gitignore'), 'utf-8');
      expect(content).toBe('node_modules/\n*.log\n');
    });

    it('should not duplicate an existing pattern', async () => {
      await writeFile(join(testRepoPath, '.gitignore'), 'node_modules/\n');
      await gitOps.addToGitignore('node_modules/');
      const content = await readFile(join(testRepoPath, '.gitignore'), 'utf-8');
      expect(content).toBe('node_modules/\n');
    });
  });

  describe('getDiff', () => {
    it('should return diff for modified file', async () => {
      await writeFile(join(testRepoPath, 'README.md'), '# Modified Content\n');

      const diff = await gitOps.getDiff('README.md');

      expect(diff.path).toBe('README.md');
      expect(diff.isBinary).toBe(false);
      expect(diff.hunks.length).toBeGreaterThan(0);
    });

    it('should return diff for staged file', async () => {
      await writeFile(join(testRepoPath, 'README.md'), '# Staged Change\n');
      await simpleGit(testRepoPath).add('README.md');

      const diff = await gitOps.getDiff('README.md', true);

      expect(diff.path).toBe('README.md');
      expect(diff.hunks.length).toBeGreaterThan(0);
    });

    it('should parse hunk headers correctly', async () => {
      // Create a file with multiple lines
      await writeFile(join(testRepoPath, 'multi.txt'), 'line1\nline2\nline3\n');
      await simpleGit(testRepoPath).add('multi.txt');
      await simpleGit(testRepoPath).commit('Add multi.txt');

      // Modify middle line
      await writeFile(join(testRepoPath, 'multi.txt'), 'line1\nmodified\nline3\n');

      const diff = await gitOps.getDiff('multi.txt');

      expect(diff.hunks).toHaveLength(1);
      expect(diff.hunks[0].content).toContain('-line2');
      expect(diff.hunks[0].content).toContain('+modified');
    });

    it('should return empty hunks for unchanged file', async () => {
      const diff = await gitOps.getDiff('README.md');

      expect(diff.hunks).toHaveLength(0);
    });
  });
});
