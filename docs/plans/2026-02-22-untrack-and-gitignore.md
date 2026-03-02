# Untrack Files & .gitignore Editor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-file "untrack" (`git rm --cached`) action, per-file "add to .gitignore" action, and a full .gitignore text editor accessible from the StatusBar.

**Architecture:** Three features all follow the existing message-passing pattern (shared types -> agent operation -> agent handler -> PWA hook -> PWA UI). The FileList component's action system is refactored from single `onAction`/`actionLabel` to an `actions[]` array to support multiple per-file actions without prop explosion.

**Tech Stack:** TypeScript, React, Zustand, simple-git, Vite, Vitest

---

## Task 1: Add shared types for untrack, gitignore-add, gitignore-read, gitignore-write

**Files:**
- Modify: `packages/shared/src/types.ts:37-53` (MessageType union)
- Modify: `packages/shared/src/types.ts:220` (after DiscardResponsePayload)
- Modify: `packages/shared/src/protocol.ts:80-92` (REQUEST_RESPONSE_MAP)

**Step 1: Add message types to the MessageType union**

In `packages/shared/src/types.ts`, add after `'git:discard:response'` (line 38):

```typescript
  | 'git:untrack'
  | 'git:untrack:response'
  | 'git:gitignore-add'
  | 'git:gitignore-add:response'
  | 'git:gitignore-read'
  | 'git:gitignore-read:response'
  | 'git:gitignore-write'
  | 'git:gitignore-write:response'
```

**Step 2: Add payload types**

In `packages/shared/src/types.ts`, add after `DiscardResponsePayload` (after line 220):

```typescript
// Untrack (git rm --cached)
export interface UntrackRequestPayload {
  paths: string[];
}

export interface UntrackResponsePayload {
  success: boolean;
  error?: string;
}

// Gitignore - Add pattern
export interface GitignoreAddRequestPayload {
  pattern: string;
}

export interface GitignoreAddResponsePayload {
  success: boolean;
  error?: string;
}

// Gitignore - Read
export type GitignoreReadRequestPayload = Record<string, never>;

export interface GitignoreReadResponsePayload {
  content: string;
  exists: boolean;
}

// Gitignore - Write
export interface GitignoreWriteRequestPayload {
  content: string;
}

export interface GitignoreWriteResponsePayload {
  success: boolean;
  error?: string;
}
```

**Step 3: Add to REQUEST_RESPONSE_MAP**

In `packages/shared/src/protocol.ts`, add to the map (after line 89, before the `handshake` entry):

```typescript
  'git:untrack': 'git:untrack:response',
  'git:gitignore-add': 'git:gitignore-add:response',
  'git:gitignore-read': 'git:gitignore-read:response',
  'git:gitignore-write': 'git:gitignore-write:response',
```

**Step 4: Verify shared package builds**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```
feat(shared): add message types for untrack and gitignore operations
```

---

## Task 2: Add agent git operations — untrack, gitignore CRUD

**Files:**
- Modify: `apps/agent/src/git/operations.ts:1-2` (imports)
- Modify: `apps/agent/src/git/operations.ts:336` (after discard method)
- Test: `apps/agent/src/git/operations.test.ts`

**Step 1: Write failing tests for untrack**

Add to `apps/agent/src/git/operations.test.ts`, after the `discard` describe block (after line 260):

```typescript
  describe('untrack', () => {
    it('should remove a tracked file from the index but keep it on disk', async () => {
      // README.md is already tracked from initial commit
      await gitOps.untrack(['README.md']);

      const status = await gitOps.getStatus();
      // File should now appear as untracked (still on disk)
      expect(status.untracked).toContain('README.md');
      // File should be staged as deleted (removed from index)
      expect(status.staged.some(f => f.path === 'README.md' && f.status === 'deleted')).toBe(true);
    });

    it('should untrack multiple files', async () => {
      // Create and commit a second file
      await writeFile(join(testRepoPath, 'tracked.txt'), 'content');
      await simpleGit(testRepoPath).add('tracked.txt');
      await simpleGit(testRepoPath).commit('Add tracked.txt');

      await gitOps.untrack(['README.md', 'tracked.txt']);

      const status = await gitOps.getStatus();
      expect(status.untracked).toContain('README.md');
      expect(status.untracked).toContain('tracked.txt');
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/git/operations.test.ts -t "untrack"`
Expected: FAIL — `gitOps.untrack is not a function`

**Step 3: Implement untrack in operations.ts**

In `apps/agent/src/git/operations.ts`, add after the `discard` method (after line 336):

```typescript
  /**
   * Untrack files (git rm --cached) — removes from index, keeps on disk
   */
  async untrack(paths: string[]): Promise<void> {
    await this.ensureInitialized();
    await this.git.rm(['--cached', ...paths]);
  }
```

**Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/git/operations.test.ts -t "untrack"`
Expected: PASS

**Step 5: Write failing tests for gitignore operations**

Add to `apps/agent/src/git/operations.test.ts`, after the `untrack` describe block. Also add `readFile` to the import from `fs/promises` at the top (line 3 already has `writeFile` — add `readFile`):

```typescript
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
```

**Step 6: Run tests to verify they fail**

Run: `cd apps/agent && npx vitest run src/git/operations.test.ts -t "readGitignore|writeGitignore|addToGitignore"`
Expected: FAIL — methods not defined

**Step 7: Implement gitignore operations**

Add imports at top of `apps/agent/src/git/operations.ts` — `readFile` and `writeFile` are already imported (line 2). Add after the `untrack` method:

```typescript
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

    // Check if pattern already exists (exact line match)
    const lines = content.split('\n');
    if (lines.some(line => line === pattern)) {
      return; // Already present
    }

    // Ensure content ends with newline before appending
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const newContent = content + prefix + pattern + '\n';
    await this.writeGitignore(newContent);
  }
```

**Step 8: Run all gitignore and untrack tests**

Run: `cd apps/agent && npx vitest run src/git/operations.test.ts -t "untrack|readGitignore|writeGitignore|addToGitignore"`
Expected: All PASS

**Step 9: Run full test suite**

Run: `cd apps/agent && npx vitest run`
Expected: All tests pass

**Step 10: Commit**

```
feat(agent): add untrack and gitignore operations to GitOperations
```

---

## Task 3: Add agent message handlers for new operations

**Files:**
- Modify: `apps/agent/src/handlers/messageHandler.ts:1-43` (imports)
- Modify: `apps/agent/src/handlers/messageHandler.ts:113-158` (switch statement)
- Modify: `apps/agent/src/handlers/messageHandler.ts:399` (after handleDiscard)
- Test: `apps/agent/src/handlers/messageHandler.test.ts`

**Step 1: Write failing tests for message handlers**

Add to `apps/agent/src/handlers/messageHandler.test.ts`, after the `git:status` describe block. Also add `readFile` to the imports from `fs/promises`:

```typescript
  describe('handleMessage - git:untrack', () => {
    it('should untrack a tracked file', async () => {
      const message = createMessage('git:untrack', { paths: ['README.md'] });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:untrack:response');
      expect(response.id).toBe(message.id);
      expect((response.payload as any).success).toBe(true);
    });
  });

  describe('handleMessage - git:gitignore-add', () => {
    it('should add a pattern to .gitignore', async () => {
      const message = createMessage('git:gitignore-add', { pattern: 'node_modules/' });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:gitignore-add:response');
      expect((response.payload as any).success).toBe(true);

      const content = await readFile(join(testRepoPath, '.gitignore'), 'utf-8');
      expect(content).toContain('node_modules/');
    });
  });

  describe('handleMessage - git:gitignore-read', () => {
    it('should read .gitignore content', async () => {
      await writeFile(join(testRepoPath, '.gitignore'), '*.log\n');

      const message = createMessage('git:gitignore-read', {});
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:gitignore-read:response');
      expect((response.payload as any).content).toBe('*.log\n');
      expect((response.payload as any).exists).toBe(true);
    });

    it('should return empty when .gitignore does not exist', async () => {
      const message = createMessage('git:gitignore-read', {});
      const response = await handler.handleMessage(message);

      expect((response.payload as any).content).toBe('');
      expect((response.payload as any).exists).toBe(false);
    });
  });

  describe('handleMessage - git:gitignore-write', () => {
    it('should write .gitignore content', async () => {
      const message = createMessage('git:gitignore-write', { content: 'dist/\n*.log\n' });
      const response = await handler.handleMessage(message);

      expect(response.type).toBe('git:gitignore-write:response');
      expect((response.payload as any).success).toBe(true);

      const content = await readFile(join(testRepoPath, '.gitignore'), 'utf-8');
      expect(content).toBe('dist/\n*.log\n');
    });
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd apps/agent && npx vitest run src/handlers/messageHandler.test.ts -t "git:untrack|git:gitignore"`
Expected: FAIL — unknown message type

**Step 3: Add imports to messageHandler.ts**

In `apps/agent/src/handlers/messageHandler.ts`, add to the import block (after `DiscardResponsePayload` on line 24):

```typescript
  UntrackRequestPayload,
  UntrackResponsePayload,
  GitignoreAddRequestPayload,
  GitignoreAddResponsePayload,
  GitignoreReadResponsePayload,
  GitignoreWriteRequestPayload,
  GitignoreWriteResponsePayload,
```

**Step 4: Add switch cases**

In `apps/agent/src/handlers/messageHandler.ts`, add after the `git:discard` case (after line 141):

```typescript
        case 'git:untrack':
          return this.handleUntrack(message as Message<UntrackRequestPayload>, peerAddress);
        case 'git:gitignore-add':
          return this.handleGitignoreAdd(message as Message<GitignoreAddRequestPayload>, peerAddress);
        case 'git:gitignore-read':
          return this.handleGitignoreRead(message, peerAddress);
        case 'git:gitignore-write':
          return this.handleGitignoreWrite(message as Message<GitignoreWriteRequestPayload>, peerAddress);
```

**Step 5: Implement handler methods**

Add after `handleDiscard` (after line 399):

```typescript
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
    try {
      const result = await this.getGit(peerAddress).readGitignore();
      const response = createMessage<GitignoreReadResponsePayload>('git:gitignore-read:response', result);
      response.id = message.id;
      return response;
    } catch (error) {
      const response = createMessage<GitignoreReadResponsePayload>('git:gitignore-read:response', {
        content: '',
        exists: false,
      });
      response.id = message.id;
      return response;
    }
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
```

**Step 6: Run handler tests**

Run: `cd apps/agent && npx vitest run src/handlers/messageHandler.test.ts`
Expected: All PASS

**Step 7: Run full agent test suite**

Run: `cd apps/agent && npx vitest run`
Expected: All tests pass

**Step 8: Commit**

```
feat(agent): add message handlers for untrack and gitignore operations
```

---

## Task 4: Add PWA hook functions for new operations

**Files:**
- Modify: `apps/pwa/src/hooks/useGitOperations.ts:1-23` (imports)
- Modify: `apps/pwa/src/hooks/useGitOperations.ts:287` (after discardChanges)
- Modify: `apps/pwa/src/hooks/useGitOperations.ts:414-434` (return object)

**Step 1: Add imports**

In `apps/pwa/src/hooks/useGitOperations.ts`, add to the import block from `@sumicom/quicksave-shared` (after line 13, `type DiscardResponsePayload`):

```typescript
  type UntrackResponsePayload,
  type GitignoreAddResponsePayload,
  type GitignoreReadResponsePayload,
  type GitignoreWriteResponsePayload,
```

**Step 2: Add hook functions**

In `apps/pwa/src/hooks/useGitOperations.ts`, add after `discardChanges` (after line 287):

```typescript
  const untrackFiles = useCallback(
    async (paths: string[]) => {
      setLoading(true);
      try {
        const message = createMessage('git:untrack', { paths });
        const response = await sendRequest<UntrackResponsePayload>(message);
        if (!response.success) {
          throw new Error(response.error || 'Failed to untrack files');
        }
        await fetchStatus();
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to untrack files');
      } finally {
        setLoading(false);
      }
    },
    [sendRequest, fetchStatus, setLoading, setError]
  );

  const addToGitignore = useCallback(
    async (pattern: string) => {
      setLoading(true);
      try {
        const message = createMessage('git:gitignore-add', { pattern });
        const response = await sendRequest<GitignoreAddResponsePayload>(message);
        if (!response.success) {
          throw new Error(response.error || 'Failed to add to .gitignore');
        }
        await fetchStatus();
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to add to .gitignore');
      } finally {
        setLoading(false);
      }
    },
    [sendRequest, fetchStatus, setLoading, setError]
  );

  const readGitignore = useCallback(async () => {
    try {
      const message = createMessage('git:gitignore-read', {});
      const response = await sendRequest<GitignoreReadResponsePayload>(message);
      return response;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to read .gitignore');
      return null;
    }
  }, [sendRequest, setError]);

  const writeGitignore = useCallback(
    async (content: string) => {
      try {
        const message = createMessage('git:gitignore-write', { content });
        const response = await sendRequest<GitignoreWriteResponsePayload>(message);
        if (!response.success) {
          throw new Error(response.error || 'Failed to write .gitignore');
        }
        await fetchStatus();
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to write .gitignore');
        return false;
      }
    },
    [sendRequest, fetchStatus, setError]
  );
```

**Step 3: Add to return object**

In `apps/pwa/src/hooks/useGitOperations.ts`, add to the return object (after `discardChanges`):

```typescript
    untrackFiles,
    addToGitignore,
    readGitignore,
    writeGitignore,
```

**Step 4: Type-check PWA**

Run: `cd apps/pwa && npx tsc --noEmit`
Expected: No new errors

**Step 5: Commit**

```
feat(pwa): add hook functions for untrack and gitignore operations
```

---

## Task 5: Refactor FileList to support multiple per-file actions

**Files:**
- Modify: `apps/pwa/src/components/FileList.tsx:10-26` (props interface)
- Modify: `apps/pwa/src/components/FileList.tsx:104-119` (destructure props)
- Modify: `apps/pwa/src/components/FileList.tsx:260-269` (per-file quick action)
- Modify: `apps/pwa/src/components/FileList.tsx:424-432` (header "Action All" button)

**Step 1: Add FileAction interface and update FileListProps**

Replace the `onAction`/`actionLabel` props in `FileListProps` (lines 15-16) with:

```typescript
interface FileAction {
  label: string;
  onAction: (paths: string[]) => void;
  primary?: boolean;
}
```

In `FileListProps`, replace:
```typescript
  onAction: (paths: string[]) => void;
  actionLabel: string;
```
With:
```typescript
  actions: FileAction[];
```

**Step 2: Update the component destructuring**

In the component function signature (lines 104-119), replace `onAction` and `actionLabel` with `actions`. Derive primary and secondary:

```typescript
  const primaryAction = actions.find(a => a.primary) || actions[0];
  const secondaryActions = actions.filter(a => a !== primaryAction);
```

**Step 3: Update per-file quick action rendering**

Replace the Quick Action button block (lines 260-269) with:

```tsx
            {/* Quick Actions */}
            <div className="flex items-center gap-1 flex-shrink-0">
              {secondaryActions.map((action) => (
                <button
                  key={action.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    action.onAction([path]);
                  }}
                  className="text-xs px-1.5 py-0.5 text-slate-400 hover:text-white hover:bg-slate-600 rounded opacity-0 group-hover:opacity-100 transition-all"
                  title={action.label}
                >
                  {action.label}
                </button>
              ))}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  primaryAction.onAction([path]);
                }}
                className="text-xs px-2 py-0.5 bg-slate-600 hover:bg-slate-500 rounded opacity-0 group-hover:opacity-100 transition-all"
              >
                {primaryAction.label}
              </button>
            </div>
```

**Step 4: Update header "Action All" button**

Replace the header action button (lines 424-432) with:

```tsx
        <button
          onClick={(e) => {
            e.stopPropagation();
            primaryAction.onAction(allPaths);
          }}
          className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded transition-colors"
        >
          {primaryAction.label} All
        </button>
```

**Step 5: Export the FileAction type**

Add `export` before `interface FileAction` so it can be imported by RepoView.

**Step 6: Type-check**

Run: `cd apps/pwa && npx tsc --noEmit`
Expected: Errors in RepoView.tsx (still using old props) — this is expected, we fix it in the next task.

**Step 7: Commit**

```
refactor(pwa): change FileList from single action to actions array
```

---

## Task 6: Wire up new actions in RepoView and App.tsx

**Files:**
- Modify: `apps/pwa/src/components/RepoView.tsx:20-31` (props interface)
- Modify: `apps/pwa/src/components/RepoView.tsx:298-350` (FileList usages)
- Modify: `apps/pwa/src/App.tsx:407-418` (RepoView props)

**Step 1: Update RepoViewProps**

In `apps/pwa/src/components/RepoView.tsx`, add to the interface (after `onDiscard`):

```typescript
  onUntrack: (paths: string[]) => void;
  onAddToGitignore: (pattern: string) => void;
```

**Step 2: Update RepoView destructuring**

Add `onUntrack` and `onAddToGitignore` to the destructured props. Remove the `_onDiscard` alias and `void _onDiscard` line since we're now using actions properly.

**Step 3: Update FileList usages to use actions array**

Replace the three FileList blocks:

**Staged:**
```tsx
        <FileList
          title="Staged"
          files={staged}
          type="staged"
          onFileClick={(path) => handleFileClick(path, 'staged')}
          actions={[
            { label: 'Unstage', onAction: onUnstage, primary: true },
            { label: 'Untrack', onAction: onUntrack },
          ]}
          expandedDiffs={expandedDiffs}
          loadingDiffs={loadingDiffs}
          onCloseDiff={handleCloseDiff}
          selectedFiles={selectedFiles}
          selectedLines={selectedLines}
          onToggleFileSelection={toggleFileSelection}
          onToggleLineSelection={toggleLineSelection}
          onSelectAllFiles={selectAllFiles}
        />
```

**Changed:**
```tsx
        <FileList
          title="Changed"
          files={unstaged}
          type="unstaged"
          onFileClick={(path) => handleFileClick(path, 'unstaged')}
          actions={[
            { label: 'Stage', onAction: onStage, primary: true },
            { label: 'Untrack', onAction: onUntrack },
          ]}
          expandedDiffs={expandedDiffs}
          loadingDiffs={loadingDiffs}
          onCloseDiff={handleCloseDiff}
          selectedFiles={selectedFiles}
          selectedLines={selectedLines}
          onToggleFileSelection={toggleFileSelection}
          onToggleLineSelection={toggleLineSelection}
          onSelectAllFiles={selectAllFiles}
        />
```

**Untracked:**
```tsx
        <FileList
          title="Untracked"
          files={untracked.map((path) => ({ path, status: 'added' as const }))}
          type="untracked"
          onFileClick={(path) => handleFileClick(path, 'untracked')}
          actions={[
            { label: 'Stage', onAction: onStage, primary: true },
            { label: 'Ignore', onAction: (paths) => paths.forEach(p => onAddToGitignore(p)) },
          ]}
          expandedDiffs={expandedDiffs}
          loadingDiffs={loadingDiffs}
          onCloseDiff={handleCloseDiff}
          selectedFiles={selectedFiles}
          selectedLines={selectedLines}
          onToggleFileSelection={toggleFileSelection}
          onToggleLineSelection={toggleLineSelection}
          onSelectAllFiles={selectAllFiles}
        />
```

**Step 4: Update App.tsx to pass new props**

In `apps/pwa/src/App.tsx`, add the new hook return values. Where `useGitOperations` is destructured, add `untrackFiles` and `addToGitignore`. Then pass them to `RepoView`:

```tsx
        <RepoView
          onRefresh={fetchStatus}
          onFetchDiff={fetchDiff}
          onStage={stageFiles}
          onUnstage={unstageFiles}
          onStagePatch={stagePatch}
          onUnstagePatch={unstagePatch}
          onDiscard={discardChanges}
          onUntrack={untrackFiles}
          onAddToGitignore={addToGitignore}
          onCommit={async (msg, desc) => { await commit(msg, desc); }}
          onGenerateAiSummary={generateCommitSummary}
          onSetApiKey={setApiKey}
        />
```

Also add `untrackFiles` and `addToGitignore` to the `useMemo` dependency array for `repoElement`.

**Step 5: Type-check**

Run: `cd apps/pwa && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```
feat(pwa): wire up untrack and add-to-gitignore actions in file lists
```

---

## Task 7: Create GitignoreEditor component and wire into StatusBar

**Files:**
- Create: `apps/pwa/src/components/GitignoreEditor.tsx`
- Modify: `apps/pwa/src/components/StatusBar.tsx:7-16` (props interface)
- Modify: `apps/pwa/src/components/StatusBar.tsx:149-196` (branch info bar)
- Modify: `apps/pwa/src/App.tsx` (pass gitignore props to StatusBar)

**Step 1: Create GitignoreEditor component**

Create `apps/pwa/src/components/GitignoreEditor.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react';

interface GitignoreEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onRead: () => Promise<{ content: string; exists: boolean } | null>;
  onWrite: (content: string) => Promise<boolean>;
}

export function GitignoreEditor({ isOpen, onClose, onRead, onWrite }: GitignoreEditorProps) {
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadContent = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await onRead();
      if (result) {
        setContent(result.content);
      }
    } catch {
      setError('Failed to load .gitignore');
    } finally {
      setIsLoading(false);
    }
  }, [onRead]);

  useEffect(() => {
    if (isOpen) {
      loadContent();
    }
  }, [isOpen, loadContent]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const success = await onWrite(content);
      if (success) {
        onClose();
      } else {
        setError('Failed to save .gitignore');
      }
    } catch {
      setError('Failed to save .gitignore');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-x-4 top-16 bottom-16 z-50 flex flex-col bg-slate-800 rounded-lg shadow-xl border border-slate-700 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="font-medium">.gitignore</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 bg-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Editor */}
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <span className="inline-block w-5 h-5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full h-full p-4 bg-transparent text-sm font-mono text-slate-200 resize-none outline-none"
              placeholder="# Add patterns to ignore, one per line&#10;node_modules/&#10;dist/&#10;*.log"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          )}
        </div>
      </div>
    </>
  );
}
```

**Step 2: Update StatusBar props**

In `apps/pwa/src/components/StatusBar.tsx`, add to `StatusBarProps` interface:

```typescript
  onOpenGitignore?: () => void;
```

Add `onOpenGitignore` to the destructured props.

**Step 3: Add .gitignore button to the branch info bar**

In `apps/pwa/src/components/StatusBar.tsx`, inside the branch info bar `<div>` (around line 150-196), add a .gitignore button between the branch name area and the repo path button. Add it after the ahead/behind span and before the repo path button:

```tsx
            {/* Gitignore Editor */}
            {onOpenGitignore && (
              <button
                onClick={onOpenGitignore}
                className="text-xs px-1.5 py-0.5 text-slate-500 hover:text-slate-300 hover:bg-slate-600 rounded transition-colors font-mono"
                title="Edit .gitignore"
              >
                .gitignore
              </button>
            )}
```

**Step 4: Wire into App.tsx**

In `apps/pwa/src/App.tsx`:

1. Add state: `const [showGitignoreEditor, setShowGitignoreEditor] = useState(false);`
2. Destructure `readGitignore` and `writeGitignore` from `useGitOperations`
3. Pass to StatusBar: `onOpenGitignore={() => setShowGitignoreEditor(true)}`
4. Import and render `GitignoreEditor`:

```tsx
        <GitignoreEditor
          isOpen={showGitignoreEditor}
          onClose={() => setShowGitignoreEditor(false)}
          onRead={readGitignore}
          onWrite={writeGitignore}
        />
```

Add this right after the `<RepoView>` component.

5. Add `readGitignore`, `writeGitignore`, `showGitignoreEditor` to the `useMemo` dependency array for `repoElement`.

**Step 5: Type-check**

Run: `cd apps/pwa && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```
feat(pwa): add .gitignore editor modal accessible from StatusBar
```

---

## Task 8: Final verification

**Step 1: Run full agent test suite**

Run: `cd apps/agent && npx vitest run`
Expected: All tests pass

**Step 2: Type-check PWA**

Run: `cd apps/pwa && npx tsc --noEmit`
Expected: No errors

**Step 3: Build PWA**

Run: `cd apps/pwa && npx vite build`
Expected: Build succeeds

**Step 4: Commit (if any remaining changes)**

```
chore: final verification — all tests pass, types clean, build succeeds
```
