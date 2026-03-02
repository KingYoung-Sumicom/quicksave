# Untrack Files & .gitignore Editor

## Overview

Three features for managing file tracking in QuickSave:

1. **`git rm --cached`** — per-file "Untrack" action on tracked files
2. **Add to .gitignore** — per-file action on untracked files
3. **.gitignore editor** — full text editor accessible from the StatusBar

## Architecture

All features follow the existing PWA <-> Agent message pattern:
1. Add message types to `packages/shared/src/types.ts`
2. Implement operation in `apps/agent/src/git/operations.ts`
3. Add handler in `apps/agent/src/handlers/messageHandler.ts`
4. Add hook function in `apps/pwa/src/hooks/useGitOperations.ts`
5. Add UI in relevant components

## Feature 1: Untrack (`git rm --cached`)

### Agent

**`apps/agent/src/git/operations.ts`** — new method:
```typescript
async untrack(paths: string[]): Promise<void> {
  await this.ensureInitialized();
  await this.git.rm(['--cached', ...paths]);
}
```

**`apps/agent/src/handlers/messageHandler.ts`** — new handler following `handleStage` pattern with repo locking.

### Shared

**`packages/shared/src/types.ts`** — new types:
- Message types: `git:untrack` / `git:untrack:response`
- `UntrackRequestPayload { paths: string[] }`
- `UntrackResponsePayload { success: boolean; error?: string }`

**`packages/shared/src/protocol.ts`** — add to `REQUEST_RESPONSE_MAP`.

### PWA

**`apps/pwa/src/hooks/useGitOperations.ts`** — new `untrackFiles(paths)` function.

**`apps/pwa/src/components/FileList.tsx`** — refactor per-file actions from single `onAction`/`actionLabel` to an `actions` array:
```typescript
interface FileAction {
  label: string;
  onAction: (paths: string[]) => void;
  primary?: boolean; // shown as text button (Stage/Unstage)
}
// Non-primary actions shown as small icon buttons on hover
```

**`apps/pwa/src/components/RepoView.tsx`** — pass untrack action to Staged and Changed sections.

### Where it appears

- **Staged files**: `[Unstage (primary), Untrack (icon)]`
- **Changed files**: `[Stage (primary), Untrack (icon)]`
- **Untracked files**: no untrack (already untracked)

## Feature 2: Add to .gitignore (per-file)

### Agent

**`apps/agent/src/git/operations.ts`** — new method:
```typescript
async addToGitignore(pattern: string): Promise<void> {
  // Appends pattern to .gitignore at repo root
  // Creates file if it doesn't exist
  // Ensures trailing newline before appending
}
```

### Shared

- Message types: `git:gitignore-add` / `git:gitignore-add:response`
- `GitignoreAddRequestPayload { pattern: string }`
- `GitignoreAddResponsePayload { success: boolean; error?: string }`

### PWA

**`apps/pwa/src/hooks/useGitOperations.ts`** — new `addToGitignore(pattern)` function.

**FileList** — uses the same actions array. Passed to the Untracked section only.

### Where it appears

- **Untracked files**: `[Stage (primary), Add to .gitignore (icon)]`

## Feature 3: .gitignore Editor

### Agent

**`apps/agent/src/git/operations.ts`** — two new methods:
```typescript
async readGitignore(): Promise<string> {
  // Reads .gitignore content, returns empty string if not found
}

async writeGitignore(content: string): Promise<void> {
  // Writes content to .gitignore at repo root
}
```

### Shared

- Message types: `git:gitignore-read` / `git:gitignore-read:response`
- `GitignoreReadRequestPayload {}` (empty)
- `GitignoreReadResponsePayload { content: string; exists: boolean }`
- Message types: `git:gitignore-write` / `git:gitignore-write:response`
- `GitignoreWriteRequestPayload { content: string }`
- `GitignoreWriteResponsePayload { success: boolean; error?: string }`

### PWA

**New component `apps/pwa/src/components/GitignoreEditor.tsx`**:
- Modal with full-screen textarea (monospace font)
- Loads content on open via `git:gitignore-read`
- Save and Cancel buttons
- Loading state while fetching/saving
- Auto-refreshes git status on save (ignored files disappear from untracked)

**`apps/pwa/src/components/StatusBar.tsx`**:
- Small `.gitignore` icon/button in the branch info bar (next to repo path)
- Only visible when connected
- Opens the GitignoreEditor modal

**`apps/pwa/src/hooks/useGitOperations.ts`**:
- `readGitignore()` and `writeGitignore(content)` functions

## FileList Actions Refactor

The current FileList takes a single `onAction`/`actionLabel` pair. This design changes it to accept an array of actions to support multiple per-file operations without prop explosion.

**Before:**
```typescript
interface FileListProps {
  onAction: (paths: string[]) => void;
  actionLabel: string;
}
```

**After:**
```typescript
interface FileAction {
  label: string;
  onAction: (paths: string[]) => void;
  primary?: boolean;
}

interface FileListProps {
  actions: FileAction[];
}
```

- Primary action: text button on hover (same as current behavior)
- Secondary actions: small icon buttons on hover, positioned before the primary action

## Action mapping per section

| Section | Primary Action | Secondary Actions |
|---------|---------------|-------------------|
| Staged | Unstage | Untrack |
| Changed | Stage | Untrack |
| Untracked | Stage | Add to .gitignore |
