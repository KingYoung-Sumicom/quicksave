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
} from '@quicksave/shared';
import { GitOperations } from '../git/operations.js';

export class MessageHandler {
  private git: GitOperations;
  private agentVersion = '0.1.0';
  private repoPath: string;

  constructor(repoPath: string, _license?: License) {
    this.repoPath = repoPath;
    this.git = new GitOperations(repoPath);
    // License handling will be implemented later
  }

  async handleMessage(message: Message): Promise<Message> {
    try {
      switch (message.type) {
        case 'handshake':
          return this.handleHandshake(message as Message<HandshakePayload>);
        case 'ping':
          return createMessage('pong', { timestamp: Date.now() });
        case 'git:status':
          return this.handleStatus(message as Message<StatusRequestPayload>);
        case 'git:diff':
          return this.handleDiff(message as Message<DiffRequestPayload>);
        case 'git:stage':
          return this.handleStage(message as Message<StageRequestPayload>);
        case 'git:unstage':
          return this.handleUnstage(message as Message<UnstageRequestPayload>);
        case 'git:commit':
          return this.handleCommit(message as Message<CommitRequestPayload>);
        case 'git:log':
          return this.handleLog(message as Message<LogRequestPayload>);
        case 'git:branches':
          return this.handleBranches();
        case 'git:checkout':
          return this.handleCheckout(message as Message<CheckoutRequestPayload>);
        case 'git:discard':
          return this.handleDiscard(message as Message<DiscardRequestPayload>);
        default:
          return this.createErrorResponse(message.id, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type: ${message.type}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(message.id, 'HANDLER_ERROR', errorMessage);
    }
  }

  private handleHandshake(message: Message<HandshakePayload>): Message<HandshakeAckPayload> {
    const response = createMessage<HandshakeAckPayload>('handshake:ack', {
      success: true,
      agentVersion: this.agentVersion,
      repoPath: this.repoPath,
    });
    response.id = message.id;
    return response;
  }

  private async handleStatus(message: Message<StatusRequestPayload>): Promise<Message<StatusResponsePayload>> {
    const status = await this.git.getStatus();
    console.log('[DEBUG] Git status:', JSON.stringify(status, null, 2));
    const response = createMessage<StatusResponsePayload>('git:status:response', status);
    response.id = message.id;
    return response;
  }

  private async handleDiff(message: Message<DiffRequestPayload>): Promise<Message<DiffResponsePayload>> {
    const { path, staged } = message.payload;
    const diff = await this.git.getDiff(path, staged);
    const response = createMessage<DiffResponsePayload>('git:diff:response', diff);
    response.id = message.id;
    return response;
  }

  private async handleStage(message: Message<StageRequestPayload>): Promise<Message<StageResponsePayload>> {
    try {
      await this.git.stage(message.payload.paths);
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
    }
  }

  private async handleUnstage(message: Message<UnstageRequestPayload>): Promise<Message<UnstageResponsePayload>> {
    try {
      await this.git.unstage(message.payload.paths);
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
    }
  }

  private async handleCommit(message: Message<CommitRequestPayload>): Promise<Message<CommitResponsePayload>> {
    try {
      const { message: commitMessage, description } = message.payload;
      const hash = await this.git.commit(commitMessage, description);
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
    }
  }

  private async handleLog(message: Message<LogRequestPayload>): Promise<Message<LogResponsePayload>> {
    const limit = message.payload.limit || 50;
    const commits = await this.git.getLog(limit);
    const response = createMessage<LogResponsePayload>('git:log:response', { commits });
    response.id = message.id;
    return response;
  }

  private async handleBranches(): Promise<Message<BranchesResponsePayload>> {
    const { branches, current } = await this.git.getBranches();
    return createMessage<BranchesResponsePayload>('git:branches:response', {
      branches,
      current,
    });
  }

  private async handleCheckout(message: Message<CheckoutRequestPayload>): Promise<Message<CheckoutResponsePayload>> {
    try {
      const { branch, create } = message.payload;
      await this.git.checkout(branch, create);
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
    }
  }

  private async handleDiscard(message: Message<DiscardRequestPayload>): Promise<Message<DiscardResponsePayload>> {
    try {
      await this.git.discard(message.payload.paths);
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
    }
  }

  private createErrorResponse(id: string, code: string, message: string): Message<ErrorPayload> {
    const response = createMessage<ErrorPayload>('error', { code, message });
    response.id = id;
    return response;
  }
}
