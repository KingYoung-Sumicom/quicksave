---
name: release
description: Bump all version strings, commit, tag, and push a new release
argument-hint: <version>
---

Release version $ARGUMENTS of quicksave.

## Step 1: Bump version strings

Determine every old Quicksave version string that must disappear before
publishing. Do not assume the package manifests are the only source of truth:
the agent also has runtime version constants and tests. Search the whole repo
excluding generated/dependency directories:

```bash
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' --glob '!dist/**' '0\.[0-9]+\.[0-9]+'
```

Replace the previous release version and any stale runtime versions with
$ARGUMENTS. Files that typically contain version strings:
- `package.json`
- `packages/shared/package.json`
- `packages/message-bus/package.json`
- `apps/agent/package.json`
- `apps/pwa/package.json`
- `apps/relay/package.json`
- `apps/agent/src/index.ts` (CLI version + display string)
- `apps/agent/src/service/run.ts` (PACKAGE_VERSION)
- `apps/agent/src/service/ipcClient.ts` (PACKAGE_VERSION)
- `apps/agent/src/handlers/messageHandler.ts` (agentVersion)
- `apps/agent/src/handlers/messageHandler.test.ts` (test assertion)
- `apps/agent/src/service/ipc.test.ts` (test assertions)
- `apps/agent/src/service/singleton.test.ts` (test assertion)

IMPORTANT: Use `rg` to find all old versions first, then replace ALL relevant
occurrences. Do NOT publish while any previous Quicksave release version
remains in tracked source/config files. Verify with a second search after
replacing. For example, when releasing `0.8.14` after a bad `0.8.13`, both
`0.8.12` and `0.8.13` must be gone:

```bash
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' --glob '!dist/**' '0\.8\.(12|13)'
```

Expected: no output. If any old version appears in runtime code, tests,
package manifests, docs for the current release, or release metadata, stop and
fix it before committing/tagging.

## Step 2: Run tests

```bash
pnpm -r build
pnpm -r test
```

All tests must pass before proceeding.

## Step 3: Commit with release note

First, find the previous version tag to determine the range of commits to summarize:

```bash
git tag --sort=-version:refname | head -2
```

Collect all commit messages since the previous tag:

```bash
git log <prev-tag>..HEAD --oneline
```

Summarize those commits into a concise **Changes** section, grouped by type (feat, fix, chore, etc.). Then create a single commit with the release note as the message body.

Do NOT include any Co-Authored-By attribution.

```bash
git add -A
git commit -m "$(cat <<'EOF'
v$ARGUMENTS

Changes:
- <summarized change 1>
- <summarized change 2>
EOF
)"
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

Confirm the publish workflow completed and npm sees the new version:

```bash
gh run list --workflow publish.yml --limit 5
npm view @sumicom/quicksave version
npm view @sumicom/quicksave-shared version
npm view @sumicom/quicksave-message-bus version
```

All three `npm view` commands must print `$ARGUMENTS`. Also repeat the old
version search one last time on the pushed commit before calling the release
done.
