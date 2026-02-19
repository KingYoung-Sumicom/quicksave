import {
  Message,
  createMessage,
  StatusRequestPayload,
  StatusResponsePayload,
  DiffRequestPayload,
  DiffResponsePayload,
  StageRequestPayload,
  StageResponsePayload,
  UnstageRequestPayload,
  UnstageResponsePayload,
  StagePatchRequestPayload,
  StagePatchResponsePayload,
  UnstagePatchRequestPayload,
  UnstagePatchResponsePayload,
  CommitRequestPayload,
  CommitResponsePayload,
  LogRequestPayload,
  LogResponsePayload,
  BranchesResponsePayload,
  CheckoutRequestPayload,
  CheckoutResponsePayload,
  DiscardRequestPayload,
  DiscardResponsePayload,
  ErrorPayload,
  HandshakePayload,
  HandshakeAckPayload,
  License,
  GenerateCommitSummaryRequestPayload,
  GenerateCommitSummaryResponsePayload,
  SetApiKeyRequestPayload,
  SetApiKeyResponsePayload,
  GetApiKeyStatusResponsePayload,
  Repository,
  ListReposResponsePayload,
  SwitchRepoRequestPayload,
  SwitchRepoResponsePayload,
  BrowseDirectoryRequestPayload,
  BrowseDirectoryResponsePayload,
  DirectoryEntry,
  AddRepoRequestPayload,
  AddRepoResponsePayload,
} from '@sumicom/quicksave-shared';
import { GitOperations } from '../git/operations.js';
import { getAnthropicApiKey, setAnthropicApiKey, hasAnthropicApiKey } from '../config.js';
import { CommitSummaryService } from '../ai/commitSummary.js';
import { readdir, stat } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';

export class MessageHandler {
  private repos: Map<string, GitOperations>;
  private agentVersion = '0.1.0';
  private defaultRepoPath: string;
  private clientRepos: Map<string, string> = new Map(); // peerAddress -> repoPath
  private repoLocks: Map<string, string> = new Map(); // repoPath -> peerAddress holding lock
  private availableRepos: Repository[];
  private aiService: CommitSummaryService | null = null;

  constructor(repos: Repository[], _license?: License) {
    this.repos = new Map();
    for (const repo of repos) {
      this.repos.set(repo.path, new GitOperations(repo.path));
    }
    this.availableRepos = repos;
    this.defaultRepoPath = repos[0].path;
  }

  private getClientRepoPath(peerAddress: string): string {
    return this.clientRepos.get(peerAddress) || this.defaultRepoPath;
  }

  private getGit(peerAddress: string): GitOperations {
    const repoPath = this.getClientRepoPath(peerAddress);
    return this.repos.get(repoPath)!;
  }

  private acquireRepoLock(repoPath: string, peerAddress: string): boolean {
    const holder = this.repoLocks.get(repoPath);
    if (holder && holder !== peerAddress) {
      return false;
    }
    this.repoLocks.set(repoPath, peerAddress);
    return true;
  }

  private releaseRepoLock(repoPath: string, peerAddress: string): void {
    if (this.repoLocks.get(repoPath) === peerAddress) {
      this.repoLocks.delete(repoPath);
    }
  }

  removeClient(peerAddress: string): void {
    this.clientRepos.delete(peerAddress);
    for (const [repoPath, holder] of this.repoLocks) {
      if (holder === peerAddress) {
        this.repoLocks.delete(repoPath);
      }
    }
  }

  private getAiService(): CommitSummaryService | null {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) return null;

    // Create service lazily and reuse for caching
    if (!this.aiService) {
      this.aiService = new CommitSummaryService(apiKey);
    }
    return this.aiService;
  }

  async handleMessage(message: Message, peerAddress: string = 'default'): Promise<Message> {
    try {
      switch (message.type) {
        case 'handshake':
          return this.handleHandshake(message as Message<HandshakePayload>, peerAddress);
        case 'ping':
          return createMessage('pong', { timestamp: Date.now() });
        case 'git:status':
          return this.handleStatus(message as Message<StatusRequestPayload>, peerAddress);
        case 'git:diff':
          return this.handleDiff(message as Message<DiffRequestPayload>, peerAddress);
        case 'git:stage':
          return this.handleStage(message as Message<StageRequestPayload>, peerAddress);
        case 'git:unstage':
          return this.handleUnstage(message as Message<UnstageRequestPayload>, peerAddress);
        case 'git:stage-patch':
          return this.handleStagePatch(message as Message<StagePatchRequestPayload>, peerAddress);
        case 'git:unstage-patch':
          return this.handleUnstagePatch(message as Message<UnstagePatchRequestPayload>, peerAddress);
        case 'git:commit':
          return this.handleCommit(message as Message<CommitRequestPayload>, peerAddress);
        case 'git:log':
          return this.handleLog(message as Message<LogRequestPayload>, peerAddress);
        case 'git:branches':
          return this.handleBranches(peerAddress);
        case 'git:checkout':
          return this.handleCheckout(message as Message<CheckoutRequestPayload>, peerAddress);
        case 'git:discard':
          return this.handleDiscard(message as Message<DiscardRequestPayload>, peerAddress);
        case 'ai:generate-commit-summary':
          return this.handleGenerateCommitSummary(message as Message<GenerateCommitSummaryRequestPayload>, peerAddress);
        case 'ai:set-api-key':
          return this.handleSetApiKey(message as Message<SetApiKeyRequestPayload>);
        case 'ai:get-api-key-status':
          return this.handleGetApiKeyStatus(message);
        case 'agent:list-repos':
          return this.handleListRepos(message, peerAddress);
        case 'agent:switch-repo':
          return this.handleSwitchRepo(message as Message<SwitchRepoRequestPayload>, peerAddress);
        case 'agent:browse-directory':
          return this.handleBrowseDirectory(message as Message<BrowseDirectoryRequestPayload>);
        case 'agent:add-repo':
          return this.handleAddRepo(message as Message<AddRepoRequestPayload>);
        default:
          return this.createErrorResponse(message.id, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type: ${message.type}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(message.id, 'HANDLER_ERROR', errorMessage);
    }
  }

  private handleHandshake(message: Message<HandshakePayload>, peerAddress: string): Message<HandshakeAckPayload> {
    const response = createMessage<HandshakeAckPayload>('handshake:ack', {
      success: true,
      agentVersion: this.agentVersion,
      repoPath: this.getClientRepoPath(peerAddress),
      availableRepos: this.availableRepos,
    });
    response.id = message.id;
    return response;
  }

  private async handleStatus(message: Message<StatusRequestPayload>, peerAddress: string): Promise<Message<StatusResponsePayload>> {
    const status = await this.getGit(peerAddress).getStatus();
    const response = createMessage<StatusResponsePayload>('git:status:response', status);
    response.id = message.id;
    return response;
  }

  private async handleDiff(message: Message<DiffRequestPayload>, peerAddress: string): Promise<Message<DiffResponsePayload>> {
    const { path, staged } = message.payload;
    const diff = await this.getGit(peerAddress).getDiff(path, staged);
    const response = createMessage<DiffResponsePayload>('git:diff:response', diff);
    response.id = message.id;
    return response;
  }

  private async handleStage(message: Message<StageRequestPayload>, peerAddress: string): Promise<Message<StageResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<StageResponsePayload>('git:stage:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).stage(message.payload.paths);
      const response = createMessage<StageResponsePayload>('git:stage:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<StageResponsePayload>('git:stage:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stage files',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleUnstage(message: Message<UnstageRequestPayload>, peerAddress: string): Promise<Message<UnstageResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<UnstageResponsePayload>('git:unstage:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).unstage(message.payload.paths);
      const response = createMessage<UnstageResponsePayload>('git:unstage:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<UnstageResponsePayload>('git:unstage:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to unstage files',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleStagePatch(message: Message<StagePatchRequestPayload>, peerAddress: string): Promise<Message<StagePatchResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<StagePatchResponsePayload>('git:stage-patch:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).stagePatch(message.payload.patch);
      const response = createMessage<StagePatchResponsePayload>('git:stage-patch:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<StagePatchResponsePayload>('git:stage-patch:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stage patch',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleUnstagePatch(message: Message<UnstagePatchRequestPayload>, peerAddress: string): Promise<Message<UnstagePatchResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<UnstagePatchResponsePayload>('git:unstage-patch:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).unstagePatch(message.payload.patch);
      const response = createMessage<UnstagePatchResponsePayload>('git:unstage-patch:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<UnstagePatchResponsePayload>('git:unstage-patch:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to unstage patch',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleCommit(message: Message<CommitRequestPayload>, peerAddress: string): Promise<Message<CommitResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<CommitResponsePayload>('git:commit:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      const { message: commitMessage, description } = message.payload;
      const hash = await this.getGit(peerAddress).commit(commitMessage, description);
      const response = createMessage<CommitResponsePayload>('git:commit:response', {
        success: true,
        hash,
      });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<CommitResponsePayload>('git:commit:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to commit',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleLog(message: Message<LogRequestPayload>, peerAddress: string): Promise<Message<LogResponsePayload>> {
    const limit = message.payload.limit || 50;
    const commits = await this.getGit(peerAddress).getLog(limit);
    const response = createMessage<LogResponsePayload>('git:log:response', { commits });
    response.id = message.id;
    return response;
  }

  private async handleBranches(peerAddress: string): Promise<Message<BranchesResponsePayload>> {
    const { branches, current } = await this.getGit(peerAddress).getBranches();
    return createMessage<BranchesResponsePayload>('git:branches:response', {
      branches,
      current,
    });
  }

  private async handleCheckout(message: Message<CheckoutRequestPayload>, peerAddress: string): Promise<Message<CheckoutResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<CheckoutResponsePayload>('git:checkout:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      const { branch, create } = message.payload;
      await this.getGit(peerAddress).checkout(branch, create);
      const response = createMessage<CheckoutResponsePayload>('git:checkout:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<CheckoutResponsePayload>('git:checkout:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to checkout',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleDiscard(message: Message<DiscardRequestPayload>, peerAddress: string): Promise<Message<DiscardResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<DiscardResponsePayload>('git:discard:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).discard(message.payload.paths);
      const response = createMessage<DiscardResponsePayload>('git:discard:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<DiscardResponsePayload>('git:discard:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to discard changes',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleGenerateCommitSummary(
    message: Message<GenerateCommitSummaryRequestPayload>,
    peerAddress: string
  ): Promise<Message<GenerateCommitSummaryResponsePayload>> {
    const aiService = this.getAiService();

    if (!aiService) {
      const response = createMessage<GenerateCommitSummaryResponsePayload>(
        'ai:generate-commit-summary:response',
        {
          success: false,
          error: 'Configure your API key in Settings',
          errorCode: 'NO_API_KEY',
        }
      );
      response.id = message.id;
      return response;
    }

    try {
      const git = this.getGit(peerAddress);
      const status = await git.getStatus();
      if (status.staged.length === 0) {
        const response = createMessage<GenerateCommitSummaryResponsePayload>(
          'ai:generate-commit-summary:response',
          {
            success: false,
            error: 'No staged changes to summarize',
            errorCode: 'NO_STAGED_CHANGES',
          }
        );
        response.id = message.id;
        return response;
      }

      // Collect diffs for all staged files
      const diffs = await Promise.all(status.staged.map((file) => git.getDiff(file.path, true)));

      // Generate summary (uses internal queue and cache)
      const result = await aiService.generateSummary({
        diffs,
        context: message.payload.context,
        model: message.payload.model,
      });

      const response = createMessage<GenerateCommitSummaryResponsePayload>(
        'ai:generate-commit-summary:response',
        {
          success: true,
          summary: result.summary,
          description: result.description,
          tokenUsage: result.tokenUsage,
          cached: result.cached,
        }
      );
      response.id = message.id;
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to generate summary';
      const isRateLimit = errorMessage.includes('rate_limit');

      const response = createMessage<GenerateCommitSummaryResponsePayload>(
        'ai:generate-commit-summary:response',
        {
          success: false,
          error: errorMessage,
          errorCode: isRateLimit ? 'RATE_LIMITED' : 'API_ERROR',
        }
      );
      response.id = message.id;
      return response;
    }
  }

  private handleSetApiKey(message: Message<SetApiKeyRequestPayload>): Message<SetApiKeyResponsePayload> {
    try {
      setAnthropicApiKey(message.payload.apiKey);
      const response = createMessage<SetApiKeyResponsePayload>('ai:set-api-key:response', {
        success: true,
      });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<SetApiKeyResponsePayload>('ai:set-api-key:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save API key',
      });
      response.id = message.id;
      return response;
    }
  }

  private handleGetApiKeyStatus(message: Message): Message<GetApiKeyStatusResponsePayload> {
    const response = createMessage<GetApiKeyStatusResponsePayload>('ai:get-api-key-status:response', {
      configured: hasAnthropicApiKey(),
    });
    response.id = message.id;
    return response;
  }

  private async handleListRepos(message: Message, peerAddress: string): Promise<Message<ListReposResponsePayload>> {
    // Refresh branch info for all repos
    const repos: Repository[] = [];
    for (const repo of this.availableRepos) {
      const git = this.repos.get(repo.path)!;
      try {
        const { current } = await git.getBranches();
        repos.push({ ...repo, currentBranch: current });
      } catch {
        repos.push(repo);
      }
    }
    const response = createMessage<ListReposResponsePayload>('agent:list-repos:response', {
      repos,
      current: this.getClientRepoPath(peerAddress),
    });
    response.id = message.id;
    return response;
  }

  private handleSwitchRepo(message: Message<SwitchRepoRequestPayload>, peerAddress: string): Message<SwitchRepoResponsePayload> {
    const { path } = message.payload;

    // Check if the requested repo is in our available repos
    if (!this.repos.has(path)) {
      const response = createMessage<SwitchRepoResponsePayload>('agent:switch-repo:response', {
        success: false,
        newPath: this.getClientRepoPath(peerAddress),
        error: `Repository not available: ${path}`,
      });
      response.id = message.id;
      return response;
    }

    this.clientRepos.set(peerAddress, path);
    const response = createMessage<SwitchRepoResponsePayload>('agent:switch-repo:response', {
      success: true,
      newPath: path,
    });
    response.id = message.id;
    return response;
  }

  private async handleBrowseDirectory(
    message: Message<BrowseDirectoryRequestPayload>
  ): Promise<Message<BrowseDirectoryResponsePayload>> {
    const requestedPath = message.payload.path || homedir();

    try {
      const entries: DirectoryEntry[] = [];
      const dirEntries = await readdir(requestedPath, { withFileTypes: true });

      for (const entry of dirEntries) {
        // Skip hidden files/folders (starting with .)
        if (entry.name.startsWith('.')) continue;

        const fullPath = join(requestedPath, entry.name);
        const isDirectory = entry.isDirectory();

        // Check if it's a git repo (has .git folder)
        let isGitRepo = false;
        if (isDirectory) {
          try {
            const gitPath = join(fullPath, '.git');
            const gitStat = await stat(gitPath);
            isGitRepo = gitStat.isDirectory();
          } catch {
            // Not a git repo
          }
        }

        entries.push({
          name: entry.name,
          path: fullPath,
          isDirectory,
          isGitRepo,
        });
      }

      // Sort: directories first, then alphabetically
      entries.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      // Calculate parent path
      const parentPath = requestedPath === '/' ? null : dirname(requestedPath);

      const response = createMessage<BrowseDirectoryResponsePayload>('agent:browse-directory:response', {
        path: requestedPath,
        parentPath,
        entries,
      });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<BrowseDirectoryResponsePayload>('agent:browse-directory:response', {
        path: requestedPath,
        parentPath: dirname(requestedPath),
        entries: [],
        error: error instanceof Error ? error.message : 'Failed to read directory',
      });
      response.id = message.id;
      return response;
    }
  }

  private async handleAddRepo(
    message: Message<AddRepoRequestPayload>
  ): Promise<Message<AddRepoResponsePayload>> {
    const { path: repoPath } = message.payload;

    // Check if already added
    if (this.repos.has(repoPath)) {
      const response = createMessage<AddRepoResponsePayload>('agent:add-repo:response', {
        success: false,
        error: 'Repository already added',
      });
      response.id = message.id;
      return response;
    }

    try {
      // Verify it's a git repo by trying to get branches
      const git = new GitOperations(repoPath);
      const { current } = await git.getBranches();

      // Add to our maps
      this.repos.set(repoPath, git);
      const newRepo: Repository = {
        path: repoPath,
        name: basename(repoPath),
        currentBranch: current,
      };
      this.availableRepos.push(newRepo);

      const response = createMessage<AddRepoResponsePayload>('agent:add-repo:response', {
        success: true,
        repo: newRepo,
      });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<AddRepoResponsePayload>('agent:add-repo:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add repository',
      });
      response.id = message.id;
      return response;
    }
  }

  private createErrorResponse(id: string, code: string, message: string): Message<ErrorPayload> {
    const response = createMessage<ErrorPayload>('error', { code, message });
    response.id = id;
    return response;
  }
}
