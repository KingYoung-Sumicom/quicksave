import { simpleGit, SimpleGit, StatusResult } from 'simple-git';
import { readFile, writeFile, unlink, stat } from 'fs/promises';
import { join, extname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import type {
  GitStatus,
  FileChange,
  FileDiff,
  ImageData,
  DiffHunk,
  Commit,
  Branch,
  FileStatus,
} from '@sumicom/quicksave-shared';

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif',
]);

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
};

export interface GitOperationsOptions {
  maxDiffFileSizeKB?: number;
}

export class GitOperations {
  private git: SimpleGit;
  private gitRoot: string | null = null;
  private initialized = false;
  private maxDiffFileSizeKB: number;

  constructor(repoPath: string, options?: GitOperationsOptions) {
    this.git = simpleGit(repoPath);
    this.maxDiffFileSizeKB =
      options?.maxDiffFileSizeKB ??
      parseInt(process.env.QUICKSAVE_MAX_DIFF_SIZE_KB || '100', 10);
  }

  /**
   * Initialize git to run from the git root directory
   * This ensures relative paths work correctly
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const gitRoot = await this.getGitRoot();
    this.git = simpleGit(gitRoot);
    this.initialized = true;
  }

  /**
   * Get the actual git repository root path
   */
  private async getGitRoot(): Promise<string> {
    if (this.gitRoot) {
      return this.gitRoot;
    }
    this.gitRoot = (await this.git.revparse(['--show-toplevel'])).trim();
    return this.gitRoot;
  }

  /**
   * Get the current git status
   */
  async getStatus(): Promise<GitStatus> {
    await this.ensureInitialized();
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
    await this.ensureInitialized();

    // Check file size before generating diff
    const fileSizeKB = await this.getFileSizeKB(path);
    if (fileSizeKB > this.maxDiffFileSizeKB) {
      // Still try to provide image preview for oversized images
      if (this.isImageFile(path)) {
        const imageData = await this.getImageData(path, staged);
        if (imageData) {
          return { path, hunks: [], isBinary: true, imageData };
        }
      }
      return {
        path,
        hunks: [],
        isBinary: false,
        truncated: true,
        truncatedReason: `File exceeds ${this.maxDiffFileSizeKB}KB limit (${fileSizeKB}KB)`,
      };
    }

    const status = await this.git.status();
    const isUntracked = status.not_added.includes(path);
    const isNewFile = status.created.includes(path);

    // For untracked files, show the full content as additions
    if (isUntracked) {
      return this.getNewFileDiff(path);
    }

    // For new staged files, show the staged content from the index
    if (staged && isNewFile) {
      return this.getStagedNewFileDiff(path);
    }

    // Normal diff
    const args = staged
      ? ['diff', '--cached', '--', path]
      : ['diff', '--', path];
    const diffOutput = await this.git.raw(args);

    // If diff is empty, return empty diff
    if (!diffOutput.trim()) {
      return {
        path,
        hunks: [],
        isBinary: false,
      };
    }

    const diff = this.parseDiff(path, diffOutput);
    if (diff.isBinary) {
      diff.imageData = await this.getImageData(path, staged);
    }
    return diff;
  }

  /**
   * Get file size in KB
   */
  private async getFileSizeKB(path: string): Promise<number> {
    try {
      const gitRoot = await this.getGitRoot();
      const fullPath = join(gitRoot, path);
      const stats = await stat(fullPath);
      return Math.ceil(stats.size / 1024);
    } catch {
      return 0; // File doesn't exist or can't be read
    }
  }

  /**
   * Get diff for a staged new file by reading content from the git index
   */
  private async getStagedNewFileDiff(path: string): Promise<FileDiff> {
    try {
      const content = await this.git.raw(['show', `:${path}`]);

      if (this.isBinaryContent(content)) {
        const imageData = await this.getImageData(path, true);
        return { path, hunks: [], isBinary: true, imageData };
      }

      return this.createSyntheticDiff(path, content);
    } catch {
      // Fallback to reading from working tree
      return this.getNewFileDiff(path);
    }
  }

  /**
   * Get diff representation for a new/untracked file (shows all content as additions)
   */
  private async getNewFileDiff(path: string): Promise<FileDiff> {
    const gitRoot = await this.getGitRoot();
    const fullPath = join(gitRoot, path);

    try {
      const content = await readFile(fullPath, 'utf-8');

      if (this.isBinaryContent(content)) {
        const imageData = await this.getImageData(path, false);
        return { path, hunks: [], isBinary: true, imageData };
      }

      return this.createSyntheticDiff(path, content);
    } catch (error) {
      console.error(`Failed to read untracked file ${fullPath}:`, error);
      return { path, hunks: [], isBinary: false };
    }
  }

  /**
   * Create a synthetic diff showing all content as additions
   */
  private createSyntheticDiff(path: string, content: string): FileDiff {
    const lines = content.split(/\r?\n/);

    // Remove trailing empty line if content ends with newline
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    if (lines.length === 0) {
      return { path, hunks: [], isBinary: false };
    }

    const hunkContent = lines.map(line => `+${line}`).join('\n');
    const hunk: DiffHunk = {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      content: `@@ -0,0 +1,${lines.length} @@\n${hunkContent}`,
    };

    return { path, hunks: [hunk], isBinary: false };
  }

  /**
   * Simple binary content detection
   */
  private isBinaryContent(content: string): boolean {
    return content.includes('\0');
  }

  private isImageFile(path: string): boolean {
    return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
  }

  private toDataUri(buffer: Buffer, path: string): string {
    const mime = MIME_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  }

  /**
   * Build ImageData for an image file, reading old (HEAD) and new versions.
   * Returns undefined if the file is not an image or exceeds size limit.
   */
  private async getImageData(path: string, staged: boolean): Promise<ImageData | undefined> {
    if (!this.isImageFile(path)) return undefined;

    const gitRoot = await this.getGitRoot();
    const status = await this.git.status();
    const isNew = status.not_added.includes(path) || status.created.includes(path);
    const isDeleted = status.deleted.includes(path);

    let newImage: string | undefined;
    let oldImage: string | undefined;

    // Read new version
    if (!isDeleted) {
      try {
        if (staged) {
          const buf = Buffer.from(await this.git.raw(['show', `:${path}`]), 'binary');
          newImage = this.toDataUri(buf, path);
        } else {
          const buf = await readFile(join(gitRoot, path));
          newImage = this.toDataUri(buf, path);
        }
      } catch { /* file may not exist */ }
    }

    // Read old version from HEAD
    if (!isNew) {
      try {
        const buf = Buffer.from(await this.git.raw(['show', `HEAD:${path}`]), 'binary');
        oldImage = this.toDataUri(buf, path);
      } catch { /* no previous version */ }
    }

    if (!newImage && !oldImage) return undefined;
    return { old: oldImage, new: newImage };
  }

  /**
   * Stage files
   */
  async stage(paths: string[]): Promise<void> {
    await this.ensureInitialized();
    await this.git.add(paths);
  }

  /**
   * Unstage files
   */
  async unstage(paths: string[]): Promise<void> {
    await this.ensureInitialized();
    await this.git.reset(['HEAD', '--', ...paths]);
  }

  /**
   * Stage a patch (for line-level staging)
   */
  async stagePatch(patch: string): Promise<void> {
    await this.ensureInitialized();
    const tempFile = await this.writeTempPatch(patch);
    try {
      await this.git.raw(['apply', '--cached', tempFile]);
    } finally {
      await this.cleanupTempFile(tempFile);
    }
  }

  /**
   * Unstage a patch (for line-level unstaging)
   */
  async unstagePatch(patch: string): Promise<void> {
    await this.ensureInitialized();
    const tempFile = await this.writeTempPatch(patch);
    try {
      await this.git.raw(['apply', '--cached', '-R', tempFile]);
    } finally {
      await this.cleanupTempFile(tempFile);
    }
  }

  /**
   * Write a patch to a temporary file
   */
  private async writeTempPatch(patch: string): Promise<string> {
    const id = randomBytes(8).toString('hex');
    const tempPath = join(tmpdir(), `quicksave-patch-${id}.patch`);
    await writeFile(tempPath, patch, 'utf-8');
    return tempPath;
  }

  /**
   * Clean up a temporary file
   */
  private async cleanupTempFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // Ignore cleanup errors
    }
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
    await this.ensureInitialized();
    await this.git.checkout(['--', ...paths]);
  }

  /**
   * Untrack files (git rm --cached) — removes from index, keeps on disk
   */
  async untrack(paths: string[]): Promise<void> {
    await this.ensureInitialized();
    await this.git.rm(['--cached', ...paths]);
  }

  /**
   * Read .gitignore content
   */
  async readGitignore(): Promise<{ content: string; exists: boolean }> {
    const gitRoot = await this.getGitRoot();
    const gitignorePath = join(gitRoot, '.gitignore');
    try {
      const content = await readFile(gitignorePath, 'utf-8');
      return { content, exists: true };
    } catch {
      return { content: '', exists: false };
    }
  }

  /**
   * Write .gitignore content
   */
  async writeGitignore(content: string): Promise<void> {
    const gitRoot = await this.getGitRoot();
    const gitignorePath = join(gitRoot, '.gitignore');
    await writeFile(gitignorePath, content, 'utf-8');
  }

  /**
   * Add a pattern to .gitignore (appends, avoids duplicates)
   */
  async addToGitignore(pattern: string): Promise<void> {
    const { content } = await this.readGitignore();
    const lines = content.split('\n');
    if (lines.some(line => line === pattern)) {
      return;
    }
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const newContent = content + prefix + pattern + '\n';
    await this.writeGitignore(newContent);
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
      for (const file of status.staged) {
        changes.push({
          path: file,
          status: this.getFileStatus(status, file),
        });
      }
    } else {
      // Use files array for accurate unstaged detection
      // working_dir indicates the status in the working directory (unstaged changes)
      for (const file of status.files) {
        const wd = file.working_dir;
        if (wd === 'M') {
          changes.push({ path: file.path, status: 'modified' });
        } else if (wd === 'D') {
          changes.push({ path: file.path, status: 'deleted' });
        }
      }
    }

    return changes;
  }

  private getFileStatus(status: StatusResult, file: string): FileStatus {
    if (status.created.includes(file)) return 'added';
    if (status.deleted.includes(file)) return 'deleted';
    if (status.renamed.some((r) => r.to === file)) return 'renamed';
    return 'modified';
  }

  private parseDiff(path: string, diffOutput: string): FileDiff {
    const hunks: DiffHunk[] = [];
    const lines = diffOutput.split(/\r?\n/);

    let currentHunk: DiffHunk | null = null;
    let hunkContent: string[] = [];

    for (const line of lines) {
      const hunkMatch = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/);

      if (hunkMatch) {
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

    if (currentHunk) {
      currentHunk.content = hunkContent.join('\n');
      hunks.push(currentHunk);
    }

    const isBinary = diffOutput.includes('Binary files') || diffOutput.includes('GIT binary patch');

    return { path, hunks, isBinary };
  }
}
