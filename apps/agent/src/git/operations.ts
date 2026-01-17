import { simpleGit, SimpleGit, StatusResult } from 'simple-git';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type {
  GitStatus,
  FileChange,
  FileDiff,
  DiffHunk,
  Commit,
  Branch,
  FileStatus,
} from '@quicksave/shared';

export class GitOperations {
  private git: SimpleGit;
  private repoPath: string;
  private gitRoot: string | null = null;

  constructor(repoPath: string) {
    this.git = simpleGit(repoPath);
    this.repoPath = repoPath;
  }

  /**
   * Get the actual git repository root path
   */
  private async getGitRoot(): Promise<string> {
    if (this.gitRoot) {
      return this.gitRoot;
    }
    // Get the actual git root directory
    this.gitRoot = (await this.git.revparse(['--show-toplevel'])).trim();
    return this.gitRoot;
  }

  /**
   * Get the current git status
   */
  async getStatus(): Promise<GitStatus> {
    const status = await this.git.status();
    const branchInfo = await this.getBranchTracking();

    return {
      branch: status.current || 'HEAD',
      ahead: branchInfo.ahead,
      behind: branchInfo.behind,
      staged: this.parseFileChanges(status, 'staged'),
      unstaged: this.parseFileChanges(status, 'unstaged'),
      untracked: status.not_added,
    };
  }

  /**
   * Get diff for a specific file
   */
  async getDiff(path: string, staged: boolean = false): Promise<FileDiff> {
    const status = await this.git.status();
    const isUntracked = status.not_added.includes(path);
    const isNewFile = status.created.includes(path);

    console.log('[DEBUG] getDiff:', { path, staged, isUntracked, isNewFile });

    // For untracked files, show the full content as additions
    if (isUntracked) {
      console.log('[DEBUG] File is untracked, showing full content');
      return this.getNewFileDiff(path);
    }

    // Try normal diff first
    const args = staged ? ['--cached', '--', path] : ['--', path];
    const diffOutput = await this.git.diff(args);

    console.log('[DEBUG] Diff output length:', diffOutput.length);

    // If diff is empty and file is newly staged (no commits yet or new file)
    if (!diffOutput.trim() && (staged || isNewFile)) {
      // Check if there are any commits
      try {
        await this.git.log({ maxCount: 1 });
      } catch {
        // No commits yet, show full content for staged files
        console.log('[DEBUG] No commits yet, showing full content for staged file');
        return this.getNewFileDiff(path);
      }

      // If file is new and staged, show full content
      if (isNewFile && staged) {
        console.log('[DEBUG] New staged file, showing full content');
        return this.getNewFileDiff(path);
      }
    }

    return this.parseDiff(path, diffOutput);
  }

  /**
   * Get diff representation for a new/untracked file (shows all content as additions)
   */
  private async getNewFileDiff(path: string): Promise<FileDiff> {
    try {
      const gitRoot = await this.getGitRoot();
      const fullPath = join(gitRoot, path);
      const content = await readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      // Check if binary
      const isBinary = this.isBinaryContent(content);
      if (isBinary) {
        return {
          path,
          hunks: [],
          isBinary: true,
        };
      }

      // Create a synthetic diff showing all lines as additions
      const hunkContent = lines.map(line => `+${line}`).join('\n');
      const hunk: DiffHunk = {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        content: `@@ -0,0 +1,${lines.length} @@\n${hunkContent}`,
      };

      return {
        path,
        hunks: [hunk],
        isBinary: false,
      };
    } catch (error) {
      console.error('[DEBUG] Error reading new file:', error);
      return {
        path,
        hunks: [],
        isBinary: false,
      };
    }
  }

  /**
   * Simple binary content detection
   */
  private isBinaryContent(content: string): boolean {
    // Check for null bytes which indicate binary content
    return content.includes('\0');
  }

  /**
   * Stage files
   */
  async stage(paths: string[]): Promise<void> {
    await this.git.add(paths);
  }

  /**
   * Unstage files
   */
  async unstage(paths: string[]): Promise<void> {
    await this.git.reset(['HEAD', '--', ...paths]);
  }

  /**
   * Create a commit
   */
  async commit(message: string, description?: string): Promise<string> {
    const fullMessage = description ? `${message}\n\n${description}` : message;
    const result = await this.git.commit(fullMessage);
    return result.commit;
  }

  /**
   * Get commit history
   */
  async getLog(limit: number = 50): Promise<Commit[]> {
    const log = await this.git.log({ maxCount: limit });

    return log.all.map((entry) => ({
      hash: entry.hash,
      shortHash: entry.hash.slice(0, 7),
      message: entry.message,
      author: entry.author_name,
      email: entry.author_email,
      date: entry.date,
    }));
  }

  /**
   * Get all branches
   */
  async getBranches(): Promise<{ branches: Branch[]; current: string }> {
    const branchSummary = await this.git.branch(['-a']);

    const branches: Branch[] = Object.entries(branchSummary.branches).map(
      ([name, info]) => ({
        name: info.name,
        current: info.current,
        remote: name.startsWith('remotes/') ? name.split('/')[1] : undefined,
      })
    );

    return {
      branches,
      current: branchSummary.current,
    };
  }

  /**
   * Checkout a branch
   */
  async checkout(branch: string, create: boolean = false): Promise<void> {
    if (create) {
      await this.git.checkoutLocalBranch(branch);
    } else {
      await this.git.checkout(branch);
    }
  }

  /**
   * Discard changes in files
   */
  async discard(paths: string[]): Promise<void> {
    await this.git.checkout(['--', ...paths]);
  }

  /**
   * Check if path is a valid git repository
   */
  async isValidRepo(): Promise<boolean> {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private async getBranchTracking(): Promise<{ ahead: number; behind: number }> {
    try {
      const status = await this.git.status();
      return {
        ahead: status.ahead,
        behind: status.behind,
      };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  private parseFileChanges(
    status: StatusResult,
    type: 'staged' | 'unstaged'
  ): FileChange[] {
    const changes: FileChange[] = [];

    if (type === 'staged') {
      // Staged files
      for (const file of status.staged) {
        changes.push({
          path: file,
          status: this.getFileStatus(status, file, 'staged'),
        });
      }
    } else {
      // Unstaged (modified) files
      for (const file of status.modified) {
        if (!status.staged.includes(file)) {
          changes.push({
            path: file,
            status: 'modified',
          });
        }
      }
      // Deleted but not staged
      for (const file of status.deleted) {
        if (!status.staged.includes(file)) {
          changes.push({
            path: file,
            status: 'deleted',
          });
        }
      }
    }

    return changes;
  }

  private getFileStatus(
    status: StatusResult,
    file: string,
    _type: 'staged' | 'unstaged'
  ): FileStatus {
    if (status.created.includes(file)) return 'added';
    if (status.deleted.includes(file)) return 'deleted';
    if (status.renamed.some((r) => r.to === file)) return 'renamed';
    return 'modified';
  }

  private parseDiff(path: string, diffOutput: string): FileDiff {
    const hunks: DiffHunk[] = [];
    const lines = diffOutput.split('\n');

    let currentHunk: DiffHunk | null = null;
    let hunkContent: string[] = [];

    for (const line of lines) {
      // Parse hunk header: @@ -start,count +start,count @@
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

      if (hunkMatch) {
        // Save previous hunk
        if (currentHunk) {
          currentHunk.content = hunkContent.join('\n');
          hunks.push(currentHunk);
        }

        currentHunk = {
          oldStart: parseInt(hunkMatch[1], 10),
          oldLines: parseInt(hunkMatch[2] || '1', 10),
          newStart: parseInt(hunkMatch[3], 10),
          newLines: parseInt(hunkMatch[4] || '1', 10),
          content: '',
        };
        hunkContent = [line];
      } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        hunkContent.push(line);
      }
    }

    // Save last hunk
    if (currentHunk) {
      currentHunk.content = hunkContent.join('\n');
      hunks.push(currentHunk);
    }

    // Check if binary
    const isBinary = diffOutput.includes('Binary files') || diffOutput.includes('GIT binary patch');

    return {
      path,
      hunks,
      isBinary,
    };
  }
}
