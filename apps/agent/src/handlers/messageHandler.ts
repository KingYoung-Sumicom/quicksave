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
  UntrackRequestPayload,
  UntrackResponsePayload,
  GitignoreAddRequestPayload,
  GitignoreAddResponsePayload,
  GitignoreReadResponsePayload,
  GitignoreWriteRequestPayload,
  GitignoreWriteResponsePayload,
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
  CodingPath,
  ListCodingPathsResponsePayload,
  AddCodingPathRequestPayload,
  AddCodingPathResponsePayload,
  ClaudeListSessionsRequestPayload,
  ClaudeListSessionsResponsePayload,
  ClaudeStartRequestPayload,
  ClaudeStartResponsePayload,
  ClaudeResumeRequestPayload,
  ClaudeResumeResponsePayload,
  ClaudeCancelRequestPayload,
  ClaudeCancelResponsePayload,
  ClaudeCloseRequestPayload,
  ClaudeCloseResponsePayload,
  ClaudeGetMessagesRequestPayload,
  ClaudeGetMessagesResponsePayload,
  ClaudeUserInputResponsePayload,
  ClaudeGetPreferencesResponsePayload,
  ClaudeSetPreferencesRequestPayload,
  ClaudeSetPreferencesResponsePayload,
  ClaudeSetSessionPermissionRequestPayload,
  ClaudeSetSessionPermissionResponsePayload,
  ClaudeActiveSessionsResponsePayload,
  generateMessageId,
} from '@sumicom/quicksave-shared';
import { GitOperations } from '../git/operations.js';
import { getAnthropicApiKey, setAnthropicApiKey, hasAnthropicApiKey, addManagedRepo, addManagedCodingPath } from '../config.js';
import { CommitSummaryService } from '../ai/commitSummary.js';
import { ClaudeCodeService } from '../ai/claudeCodeService.js';
import { readdir, stat } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';

export class MessageHandler {
  private repos: Map<string, GitOperations>;
  private agentVersion = '0.5.2';
  private defaultRepoPath: string;
  private clientRepos: Map<string, string> = new Map(); // peerAddress -> repoPath
  private repoLocks: Map<string, string> = new Map(); // repoPath -> peerAddress holding lock
  private availableRepos: Repository[];
  private codingPaths: Map<string, CodingPath> = new Map(); // path -> CodingPath
  private aiService: CommitSummaryService | null = null;
  private claudeService: ClaudeCodeService = new ClaudeCodeService();
  onPeerSubscribed?: (peerAddress: string, sessionId: string) => void;

  constructor(repos: Repository[], _license?: License, codingPaths?: string[]) {
    this.repos = new Map();
    for (const repo of repos) {
      this.repos.set(repo.path, new GitOperations(repo.path));
    }
    this.availableRepos = repos;
    this.defaultRepoPath = repos.length > 0 ? repos[0].path : '';

    // Load explicit coding paths only (repos and coding paths are independent)
    if (codingPaths) {
      for (const p of codingPaths) {
        this.codingPaths.set(p, { path: p, name: basename(p) });
      }
    }
  }

  addRepo(repo: Repository): void {
    if (this.repos.has(repo.path)) return;
    this.repos.set(repo.path, new GitOperations(repo.path));
    this.availableRepos.push(repo);
    if (!this.defaultRepoPath) {
      this.defaultRepoPath = repo.path;
    }
  }

  removeRepo(path: string): void {
    this.repos.delete(path);
    this.availableRepos = this.availableRepos.filter((r) => r.path !== path);
    if (this.defaultRepoPath === path) {
      this.defaultRepoPath = this.availableRepos.length > 0 ? this.availableRepos[0].path : '';
    }
  }

  private getClientRepoPath(peerAddress: string): string {
    return this.clientRepos.get(peerAddress) || this.defaultRepoPath;
  }

  private getGit(peerAddress: string): GitOperations {
    const repoPath = this.getClientRepoPath(peerAddress);
    const git = this.repos.get(repoPath);
    if (!git) {
      throw new Error('No repository selected. Please add a repository first.');
    }
    return git;
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
    // Pending user input requests are NOT auto-approved on disconnect.
    // They persist until the user reconnects and explicitly responds.
  }

  cleanup(): void {
    this.claudeService.cleanup();
  }

  getActiveSessionCount(): number {
    return this.claudeService.getActiveSessionCount();
  }

  getClaudeService(): ClaudeCodeService {
    return this.claudeService;
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

  async handleMessage(
    message: Message,
    peerAddress: string = 'default',
  ): Promise<Message> {
    const isVerbose = message.type.startsWith('claude:') || message.type.startsWith('agent:add');
    if (isVerbose) {
      console.log(`[msg] ${message.type} from ${peerAddress.slice(0, 12)}`);
    }
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
        case 'git:untrack':
          return this.handleUntrack(message as Message<UntrackRequestPayload>, peerAddress);
        case 'git:gitignore-add':
          return this.handleGitignoreAdd(message as Message<GitignoreAddRequestPayload>, peerAddress);
        case 'git:gitignore-read':
          return this.handleGitignoreRead(message, peerAddress);
        case 'git:gitignore-write':
          return this.handleGitignoreWrite(message as Message<GitignoreWriteRequestPayload>, peerAddress);
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
        case 'agent:list-coding-paths':
          return this.handleListCodingPaths(message);
        case 'agent:add-coding-path':
          return this.handleAddCodingPath(message as Message<AddCodingPathRequestPayload>);
        // Claude Code SDK
        case 'claude:list-sessions':
          return this.handleClaudeListSessions(message as Message<ClaudeListSessionsRequestPayload>, peerAddress);
        case 'claude:start':
          return this.handleClaudeStart(message as Message<ClaudeStartRequestPayload>, peerAddress);
        case 'claude:resume':
          return this.handleClaudeResume(message as Message<ClaudeResumeRequestPayload>, peerAddress);
        case 'claude:cancel':
          return this.handleClaudeCancel(message as Message<ClaudeCancelRequestPayload>);
        case 'claude:close':
          return this.handleClaudeClose(message as Message<ClaudeCloseRequestPayload>);
        case 'claude:get-messages':
          return this.handleClaudeGetMessages(message as Message<ClaudeGetMessagesRequestPayload>, peerAddress);
        case 'claude:user-input-response':
          return this.handleClaudeUserInputResponse(message as Message<ClaudeUserInputResponsePayload>);
        case 'claude:get-preferences':
          return this.handleGetPreferences(message);
        case 'claude:set-preferences':
          return this.handleSetPreferences(message as Message<ClaudeSetPreferencesRequestPayload>);
        case 'claude:set-session-permission':
          return this.handleSetSessionPermission(message as Message<ClaudeSetSessionPermissionRequestPayload>);
        case 'claude:active-sessions':
          return this.handleGetActiveSessions(message);
        default:
          return this.createErrorResponse(message.id, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type: ${message.type}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(message.id, 'HANDLER_ERROR', errorMessage);
    }
  }

  private handleHandshake(
    message: Message<HandshakePayload>,
    peerAddress: string,
  ): Message<HandshakeAckPayload> {
    const response = createMessage<HandshakeAckPayload>('handshake:ack', {
      success: true,
      agentVersion: this.agentVersion,
      repoPath: this.getClientRepoPath(peerAddress),
      availableRepos: this.availableRepos,
      availableCodingPaths: [...this.codingPaths.values()],
      preferences: this.claudeService.getPreferences(),
    });
    response.id = message.id;

    // Re-emit pending user input requests so they get broadcast to the new peer
    const pending = this.claudeService.getPendingInputRequests();
    for (const request of pending) {
      console.log(`[handshake] re-emitting pending user input: requestId=${request.requestId}`);
      this.claudeService.emit('user-input-request', request);
    }

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

  private async handleUntrack(message: Message<UntrackRequestPayload>, peerAddress: string): Promise<Message<UntrackResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<UntrackResponsePayload>('git:untrack:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).untrack(message.payload.paths);
      const response = createMessage<UntrackResponsePayload>('git:untrack:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<UntrackResponsePayload>('git:untrack:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to untrack files',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleGitignoreAdd(message: Message<GitignoreAddRequestPayload>, peerAddress: string): Promise<Message<GitignoreAddResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<GitignoreAddResponsePayload>('git:gitignore-add:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).addToGitignore(message.payload.pattern);
      const response = createMessage<GitignoreAddResponsePayload>('git:gitignore-add:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<GitignoreAddResponsePayload>('git:gitignore-add:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add to .gitignore',
      });
      response.id = message.id;
      return response;
    } finally {
      this.releaseRepoLock(repoPath, peerAddress);
    }
  }

  private async handleGitignoreRead(message: Message, peerAddress: string): Promise<Message<GitignoreReadResponsePayload>> {
    const { content, exists } = await this.getGit(peerAddress).readGitignore();
    const response = createMessage<GitignoreReadResponsePayload>('git:gitignore-read:response', { content, exists });
    response.id = message.id;
    return response;
  }

  private async handleGitignoreWrite(message: Message<GitignoreWriteRequestPayload>, peerAddress: string): Promise<Message<GitignoreWriteResponsePayload>> {
    const repoPath = this.getClientRepoPath(peerAddress);
    if (!this.acquireRepoLock(repoPath, peerAddress)) {
      const response = createMessage<GitignoreWriteResponsePayload>('git:gitignore-write:response', {
        success: false,
        error: 'Repository is busy — another device is performing an operation',
      });
      response.id = message.id;
      return response;
    }
    try {
      await this.getGit(peerAddress).writeGitignore(message.payload.content);
      const response = createMessage<GitignoreWriteResponsePayload>('git:gitignore-write:response', { success: true });
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<GitignoreWriteResponsePayload>('git:gitignore-write:response', {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to write .gitignore',
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
      // Verify it's a git repo and resolve to actual root
      const git = new GitOperations(repoPath);
      const { current } = await git.getBranches();
      const rootPath = await git.getGitRoot();

      // Check if already added (by resolved root path)
      if (this.repos.has(rootPath)) {
        const response = createMessage<AddRepoResponsePayload>('agent:add-repo:response', {
          success: false,
          error: 'Repository already added',
        });
        response.id = message.id;
        return response;
      }

      // Add to our maps using the actual git root
      this.repos.set(rootPath, git);
      const newRepo: Repository = {
        path: rootPath,
        name: basename(rootPath),
        currentBranch: current,
      };
      this.availableRepos.push(newRepo);
      // Persist to agent.json
      addManagedRepo(rootPath);

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

  // ============================================================================
  // Coding Path Handlers
  // ============================================================================

  private handleListCodingPaths(message: Message): Message<ListCodingPathsResponsePayload> {
    const response = createMessage<ListCodingPathsResponsePayload>(
      'agent:list-coding-paths:response',
      { paths: [...this.codingPaths.values()] }
    );
    response.id = message.id;
    return response;
  }

  private async handleAddCodingPath(
    message: Message<AddCodingPathRequestPayload>
  ): Promise<Message<AddCodingPathResponsePayload>> {
    const { path: codingPath } = message.payload;

    if (this.codingPaths.has(codingPath)) {
      const response = createMessage<AddCodingPathResponsePayload>(
        'agent:add-coding-path:response',
        { success: false, error: 'Coding path already added' }
      );
      response.id = message.id;
      return response;
    }

    try {
      // Verify directory exists
      const dirStat = await stat(codingPath);
      if (!dirStat.isDirectory()) {
        const response = createMessage<AddCodingPathResponsePayload>(
          'agent:add-coding-path:response',
          { success: false, error: 'Path is not a directory' }
        );
        response.id = message.id;
        return response;
      }

      const newPath: CodingPath = { path: codingPath, name: basename(codingPath) };
      this.codingPaths.set(codingPath, newPath);
      addManagedCodingPath(codingPath);

      const response = createMessage<AddCodingPathResponsePayload>(
        'agent:add-coding-path:response',
        { success: true, path: newPath }
      );
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<AddCodingPathResponsePayload>(
        'agent:add-coding-path:response',
        { success: false, error: error instanceof Error ? error.message : 'Failed to add coding path' }
      );
      response.id = message.id;
      return response;
    }
  }

  // ============================================================================
  // Claude Code SDK Handlers
  // ============================================================================

  private async handleClaudeListSessions(
    message: Message<ClaudeListSessionsRequestPayload>,
    peerAddress: string
  ): Promise<Message<ClaudeListSessionsResponsePayload>> {
    try {
      const cwd = message.payload.cwd || this.getClientRepoPath(peerAddress);
      const sessions = await this.claudeService.listAvailableSessions(cwd);
      const response = createMessage<ClaudeListSessionsResponsePayload>(
        'claude:list-sessions:response',
        { sessions }
      );
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<ClaudeListSessionsResponsePayload>(
        'claude:list-sessions:response',
        { sessions: [], error: error instanceof Error ? error.message : 'Failed to list sessions' }
      );
      response.id = message.id;
      return response;
    }
  }

  private async handleClaudeStart(
    message: Message<ClaudeStartRequestPayload>,
    peerAddress: string,
  ): Promise<Message<ClaudeStartResponsePayload>> {
    const { prompt, cwd: payloadCwd, allowedTools, systemPrompt, model, permissionMode } = message.payload;
    const cwd = payloadCwd || this.getClientRepoPath(peerAddress);
    const streamId = generateMessageId();
    console.log(`[claude:start] cwd=${cwd} prompt=${prompt.slice(0, 80)}`);

    try {
      const sessionId = await this.claudeService.startSession({
        prompt, cwd, streamId, allowedTools, systemPrompt, model, permissionMode,
      });

      console.log(`[claude:start] session created: ${sessionId}`);
      this.onPeerSubscribed?.(peerAddress, sessionId);
      const response = createMessage<ClaudeStartResponsePayload>(
        'claude:start:response',
        { success: true, sessionId, streamId }
      );
      response.id = message.id;
      return response;
    } catch (error) {
      console.error(`[claude:start] error:`, error);
      const response = createMessage<ClaudeStartResponsePayload>(
        'claude:start:response',
        { success: false, error: error instanceof Error ? error.message : 'Failed to start session' }
      );
      response.id = message.id;
      return response;
    }
  }

  private async handleClaudeResume(
    message: Message<ClaudeResumeRequestPayload>,
    peerAddress: string,
  ): Promise<Message<ClaudeResumeResponsePayload>> {
    const { sessionId: requestedId, prompt, cwd: payloadCwd } = message.payload;
    const cwd = payloadCwd || this.getClientRepoPath(peerAddress);
    const streamId = generateMessageId();
    console.log(`[claude:resume] session=${requestedId} cwd=${cwd} prompt=${prompt.slice(0, 80)}`);

    try {
      const actualSessionId = await this.claudeService.resumeSession({
        sessionId: requestedId, prompt, cwd, streamId,
      });

      console.log(`[claude:resume] session resumed: ${actualSessionId}`);
      this.onPeerSubscribed?.(peerAddress, actualSessionId);
      const response = createMessage<ClaudeResumeResponsePayload>(
        'claude:resume:response',
        { success: true, sessionId: actualSessionId, streamId }
      );
      response.id = message.id;
      return response;
    } catch (error) {
      console.error(`[claude:resume] error:`, error);
      const response = createMessage<ClaudeResumeResponsePayload>(
        'claude:resume:response',
        { success: false, error: error instanceof Error ? error.message : 'Failed to resume session' }
      );
      response.id = message.id;
      return response;
    }
  }

  private handleClaudeCancel(
    message: Message<ClaudeCancelRequestPayload>
  ): Message<ClaudeCancelResponsePayload> {
    const { sessionId } = message.payload;
    const success = this.claudeService.cancelSession(sessionId);
    const response = createMessage<ClaudeCancelResponsePayload>(
      'claude:cancel:response',
      { success, error: success ? undefined : 'Session not found or already ended' }
    );
    response.id = message.id;
    return response;
  }

  private handleClaudeClose(
    message: Message<ClaudeCloseRequestPayload>
  ): Message<ClaudeCloseResponsePayload> {
    const { sessionId } = message.payload;
    const success = this.claudeService.closeSession(sessionId);
    console.log(`[claude:close] session=${sessionId} success=${success}`);
    const response = createMessage<ClaudeCloseResponsePayload>(
      'claude:close:response',
      { success, error: success ? undefined : 'Session not found or already closed' }
    );
    response.id = message.id;
    return response;
  }

  private handleClaudeUserInputResponse(
    message: Message<ClaudeUserInputResponsePayload>
  ): Message {
    const resolved = this.claudeService.resolveUserInput(message.payload);
    console.log(`[claude:user-input-response] requestId=${message.payload.requestId} action=${message.payload.action} resolved=${resolved}`);
    // No dedicated response type — just acknowledge
    const response = createMessage('claude:user-input-response', { success: resolved });
    response.id = message.id;
    return response;
  }

  private async handleClaudeGetMessages(
    message: Message<ClaudeGetMessagesRequestPayload>,
    peerAddress: string
  ): Promise<Message<ClaudeGetMessagesResponsePayload>> {
    const { sessionId, cwd: payloadCwd, offset = 0, limit = 50 } = message.payload;
    const cwd = payloadCwd || this.getClientRepoPath(peerAddress);
    this.onPeerSubscribed?.(peerAddress, sessionId);

    try {
      const result = await this.claudeService.getMessages(sessionId, cwd, offset, limit);
      const response = createMessage<ClaudeGetMessagesResponsePayload>(
        'claude:get-messages:response',
        result
      );
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<ClaudeGetMessagesResponsePayload>(
        'claude:get-messages:response',
        {
          messages: [],
          total: 0,
          hasMore: false,
          error: error instanceof Error ? error.message : 'Failed to get messages',
        }
      );
      response.id = message.id;
      return response;
    }
  }

  private handleGetPreferences(message: Message): Message<ClaudeGetPreferencesResponsePayload> {
    const response = createMessage<ClaudeGetPreferencesResponsePayload>(
      'claude:get-preferences:response',
      { preferences: this.claudeService.getPreferences() },
    );
    response.id = message.id;
    return response;
  }

  private handleSetPreferences(message: Message<ClaudeSetPreferencesRequestPayload>): Message<ClaudeSetPreferencesResponsePayload> {
    const applied = this.claudeService.setPreferences(message.payload.preferences);
    const response = createMessage<ClaudeSetPreferencesResponsePayload>(
      'claude:set-preferences:response',
      { success: true, preferences: applied },
    );
    response.id = message.id;
    return response;
  }

  private handleSetSessionPermission(message: Message<ClaudeSetSessionPermissionRequestPayload>): Message<ClaudeSetSessionPermissionResponsePayload> {
    const { sessionId, permissionMode } = message.payload;
    const validModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
    const success = validModes.includes(permissionMode) && this.claudeService.setPermissionLevel(sessionId, permissionMode as any);
    const response = createMessage<ClaudeSetSessionPermissionResponsePayload>(
      'claude:set-session-permission:response',
      { success, sessionId, permissionMode },
    );
    response.id = message.id;
    return response;
  }

  private handleGetActiveSessions(message: Message): Message<ClaudeActiveSessionsResponsePayload> {
    const sessions = this.claudeService.getActiveSessions();
    const response = createMessage<ClaudeActiveSessionsResponsePayload>(
      'claude:active-sessions:response',
      { sessions },
    );
    response.id = message.id;
    return response;
  }

  private createErrorResponse(id: string, code: string, message: string): Message<ErrorPayload> {
    const response = createMessage<ErrorPayload>('error', { code, message });
    response.id = id;
    return response;
  }
}
