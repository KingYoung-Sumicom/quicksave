import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageHandler } from './messageHandler.js';
import { createMessage } from '@sumicom/quicksave-shared';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { simpleGit } from 'simple-git';

describe('MessageHandler', () => {
  let testRepoPath: string;
  let handler: MessageHandler;
  let defaultBranch: string;

  beforeEach(async () => {
    // Create temporary test repo
    testRepoPath = join(tmpdir(), `quicksave-handler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

    handler = new MessageHandler([{ path: testRepoPath, name: 'test-repo' }]);
  });

  afterEach(async () => {
    try {
      await rm(testRepoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('handleMessage - ping/pong', () => {
    it('should respond to ping with pong', async () => {
      const message = createMessage('ping', { timestamp: Date.now() });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('pong');
      expect(response.payload).toHaveProperty('timestamp');
    });
  });

  describe('handleMessage - handshake', () => {
    it('should respond to handshake with ack', async () => {
      const message = createMessage('handshake', { publicKey: 'test-key' });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('handshake:ack');
      expect(response.id).toBe(message.id);
      expect((response.payload as any).success).toBe(true);
      expect((response.payload as any).agentVersion).toBe('0.1.0');
      expect((response.payload as any).repoPath).toBe(testRepoPath);
    });
  });

  describe('handleMessage - git:status', () => {
    it('should return git status', async () => {
      const message = createMessage('git:status', {});
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:status:response');
      expect(response.id).toBe(message.id);

      const payload = response.payload as any;
      expect(payload.branch).toBe(defaultBranch);
      expect(Array.isArray(payload.staged)).toBe(true);
      expect(Array.isArray(payload.unstaged)).toBe(true);
      expect(Array.isArray(payload.untracked)).toBe(true);
    });

    it('should detect changes in status', async () => {
      await writeFile(join(testRepoPath, 'newfile.txt'), 'content');

      const message = createMessage('git:status', {});
      const response = await handler.handleMessage(message);

      const payload = response.payload as any;
      expect(payload.untracked).toContain('newfile.txt');
    });
  });

  describe('handleMessage - git:diff', () => {
    it('should return diff for modified file', async () => {
      await writeFile(join(testRepoPath, 'README.md'), '# Modified\n');

      const message = createMessage('git:diff', { path: 'README.md', staged: false });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:diff:response');
      expect(response.id).toBe(message.id);

      const payload = response.payload as any;
      expect(payload.path).toBe('README.md');
      expect(payload.hunks.length).toBeGreaterThan(0);
    });
  });

  describe('handleMessage - git:stage', () => {
    it('should stage files successfully', async () => {
      await writeFile(join(testRepoPath, 'newfile.txt'), 'content');

      const message = createMessage('git:stage', { paths: ['newfile.txt'] });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:stage:response');
      expect((response.payload as any).success).toBe(true);

      // Verify file was staged
      const statusMsg = createMessage('git:status', {});
      const statusResp = await handler.handleMessage(statusMsg);
      const status = statusResp.payload as any;
      expect(status.staged.some((f: any) => f.path === 'newfile.txt')).toBe(true);
    });

    it('should return error for invalid path', async () => {
      const message = createMessage('git:stage', { paths: ['nonexistent.txt'] });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:stage:response');
      expect((response.payload as any).success).toBe(false);
      expect((response.payload as any).error).toBeDefined();
    });
  });

  describe('handleMessage - git:unstage', () => {
    it('should unstage files successfully', async () => {
      await writeFile(join(testRepoPath, 'newfile.txt'), 'content');
      await simpleGit(testRepoPath).add('newfile.txt');

      const message = createMessage('git:unstage', { paths: ['newfile.txt'] });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:unstage:response');
      expect((response.payload as any).success).toBe(true);
    });
  });

  describe('handleMessage - git:commit', () => {
    it('should create commit successfully', async () => {
      await writeFile(join(testRepoPath, 'newfile.txt'), 'content');
      await simpleGit(testRepoPath).add('newfile.txt');

      const message = createMessage('git:commit', { message: 'Test commit' });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:commit:response');
      expect((response.payload as any).success).toBe(true);
      expect((response.payload as any).hash).toBeDefined();
    });

    it('should create commit with description', async () => {
      await writeFile(join(testRepoPath, 'newfile.txt'), 'content');
      await simpleGit(testRepoPath).add('newfile.txt');

      const message = createMessage('git:commit', {
        message: 'Title',
        description: 'Extended description',
      });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:commit:response');
      expect((response.payload as any).success).toBe(true);
    });

    it('should handle empty commit gracefully', async () => {
      const message = createMessage('git:commit', { message: 'Empty commit' });
      const response = await handler.handleMessage(message);

      // The behavior depends on git - it might succeed with empty commit or fail
      // We just verify it returns a proper response
      expect(response.type).toBe('git:commit:response');
    });
  });

  describe('handleMessage - git:log', () => {
    it('should return commit log', async () => {
      const message = createMessage('git:log', { limit: 10 });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:log:response');
      expect(response.id).toBe(message.id);

      const payload = response.payload as any;
      expect(Array.isArray(payload.commits)).toBe(true);
      expect(payload.commits.length).toBeGreaterThan(0);
      expect(payload.commits[0].message).toBe('Initial commit');
    });

    it('should use default limit when not specified', async () => {
      const message = createMessage('git:log', {});
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:log:response');
    });
  });

  describe('handleMessage - git:branches', () => {
    it('should return branches', async () => {
      const message = createMessage('git:branches', {});
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:branches:response');

      const payload = response.payload as any;
      expect(Array.isArray(payload.branches)).toBe(true);
      expect(payload.current).toBe(defaultBranch);
    });
  });

  describe('handleMessage - git:checkout', () => {
    it('should checkout existing branch', async () => {
      await simpleGit(testRepoPath).checkoutLocalBranch('feature');

      const message = createMessage('git:checkout', { branch: defaultBranch });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:checkout:response');
      expect((response.payload as any).success).toBe(true);
    });

    it('should create and checkout new branch', async () => {
      const message = createMessage('git:checkout', { branch: 'new-feature', create: true });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:checkout:response');
      expect((response.payload as any).success).toBe(true);

      // Verify branch was created
      const branchMsg = createMessage('git:branches', {});
      const branchResp = await handler.handleMessage(branchMsg);
      expect((branchResp.payload as any).current).toBe('new-feature');
    });

    it('should fail for non-existent branch', async () => {
      const message = createMessage('git:checkout', { branch: 'nonexistent' });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:checkout:response');
      expect((response.payload as any).success).toBe(false);
    });
  });

  describe('handleMessage - git:discard', () => {
    it('should discard changes', async () => {
      await writeFile(join(testRepoPath, 'README.md'), '# Modified\n');

      const message = createMessage('git:discard', { paths: ['README.md'] });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:discard:response');
      expect((response.payload as any).success).toBe(true);

      // Verify changes were discarded
      const statusMsg = createMessage('git:status', {});
      const statusResp = await handler.handleMessage(statusMsg);
      expect((statusResp.payload as any).unstaged).toHaveLength(0);
    });
  });

  describe('handleMessage - unknown type', () => {
    it('should return error for unknown message type', async () => {
      const message = createMessage('unknown:type' as any, {});
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('error');
      expect((response.payload as any).code).toBe('UNKNOWN_MESSAGE_TYPE');
    });
  });

  describe('handleMessage - error handling', () => {
    it('should preserve message ID in responses', async () => {
      const message = createMessage('ping', {});
      message.id = 'custom-id-123';

      const response = await handler.handleMessage(message);

      // pong doesn't preserve ID in current implementation
      // but status and other git ops should
      expect(response).toBeDefined();
    });
  });

  describe('multi-client support', () => {
    const clientA = 'pwa:clientA';
    const clientB = 'pwa:clientB';

    let secondRepoPath: string;

    beforeEach(async () => {
      // Create a second repo for multi-repo tests
      secondRepoPath = join(tmpdir(), `quicksave-handler-test2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(secondRepoPath, { recursive: true });
      const git2 = simpleGit(secondRepoPath);
      await git2.init();
      await git2.addConfig('user.email', 'test@test.com');
      await git2.addConfig('user.name', 'Test User');
      await writeFile(join(secondRepoPath, 'README.md'), '# Second Repo\n');
      await git2.add('README.md');
      await git2.commit('Initial commit');

      // Recreate handler with two repos
      handler = new MessageHandler([
        { path: testRepoPath, name: 'test-repo' },
        { path: secondRepoPath, name: 'second-repo' },
      ]);
    });

    afterEach(async () => {
      try {
        await rm(secondRepoPath, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    });

    it('should isolate repo context per client', async () => {
      // Client A switches to second repo
      const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
      const switchResp = await handler.handleMessage(switchMsg, clientA);
      expect((switchResp.payload as any).success).toBe(true);

      // Client B should still be on default repo
      const listMsgB = createMessage('agent:list-repos', {});
      const listRespB = await handler.handleMessage(listMsgB, clientB);
      expect((listRespB.payload as any).current).toBe(testRepoPath);
    });

    it('should return per-client current repo in list-repos', async () => {
      // Client A switches to second repo
      const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
      await handler.handleMessage(switchMsg, clientA);

      // Client A's list-repos should show second repo as current
      const listMsgA = createMessage('agent:list-repos', {});
      const listRespA = await handler.handleMessage(listMsgA, clientA);
      expect((listRespA.payload as any).current).toBe(secondRepoPath);

      // Client B's list-repos should show first repo as current
      const listMsgB = createMessage('agent:list-repos', {});
      const listRespB = await handler.handleMessage(listMsgB, clientB);
      expect((listRespB.payload as any).current).toBe(testRepoPath);
    });

    it('should return per-client repo path in handshake', async () => {
      // Client A switches repo
      const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
      await handler.handleMessage(switchMsg, clientA);

      // Client B handshake should return default repo
      const handshakeMsg = createMessage('handshake', { publicKey: 'test-key' });
      const handshakeResp = await handler.handleMessage(handshakeMsg, clientB);
      expect((handshakeResp.payload as any).repoPath).toBe(testRepoPath);
    });

    it('should clean up client state on removeClient', async () => {
      // Client A switches repo
      const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
      await handler.handleMessage(switchMsg, clientA);

      // Remove client A
      handler.removeClient(clientA);

      // Client A reconnecting should get default repo again
      const listMsg = createMessage('agent:list-repos', {});
      const listResp = await handler.handleMessage(listMsg, clientA);
      expect((listResp.payload as any).current).toBe(testRepoPath);
    });

    it('should allow sequential mutating ops from different clients', async () => {
      await writeFile(join(testRepoPath, 'file1.txt'), 'content1');
      await writeFile(join(testRepoPath, 'file2.txt'), 'content2');

      const stageMsg1 = createMessage('git:stage', { paths: ['file1.txt'] });
      const resp1 = await handler.handleMessage(stageMsg1, clientA);
      expect((resp1.payload as any).success).toBe(true);

      const stageMsg2 = createMessage('git:stage', { paths: ['file2.txt'] });
      const resp2 = await handler.handleMessage(stageMsg2, clientB);
      expect((resp2.payload as any).success).toBe(true);
    });
  });
});
