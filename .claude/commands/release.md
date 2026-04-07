---
description: Bump all version strings, commit, tag, and push a new release
---

Release version $ARGUMENTS of quicksave.

## Step 1: Bump version strings

Search for ALL occurrences of the current version across the codebase and replace with $ARGUMENTS:

```bash
grep -rn '<current_version>' apps/agent/ packages/shared/ --include='*.ts' --include='*.json'
```

Files that typically contain version strings:
- `packages/shared/package.json`
- `apps/agent/package.json`
- `apps/agent/src/index.ts` (CLI version + display string)
- `apps/agent/src/service/run.ts` (PACKAGE_VERSION)
- `apps/agent/src/service/ipcClient.ts` (PACKAGE_VERSION)
- `apps/agent/src/handlers/messageHandler.ts` (agentVersion)
- `apps/agent/src/handlers/messageHandler.test.ts` (test assertion)
- `apps/agent/src/service/ipc.test.ts` (test assertions)
- `apps/agent/src/service/singleton.test.ts` (test assertion)

IMPORTANT: Use grep to find the current version first, then replace ALL occurrences. Do NOT leave any behind. Verify with a second grep after replacing.

## Step 2: Run tests

```bash
cd apps/agent && npx vitest run
```

All tests must pass before proceeding.

## Step 3: Commit

Create a single commit with message: `v$ARGUMENTS`

Do NOT include any Co-Authored-By attribution.

```bash
git add -A
git commit -m "v$ARGUMENTS"
```

## Step 4: Tag and push

```bash
git tag v$ARGUMENTS
git push origin main --tags
```

## Step 5: Verify

Confirm the tag was pushed:
```bash
git log --oneline -1
git tag -l "v$ARGUMENTS"
```
