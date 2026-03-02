# npm Publish Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automate publishing `@sumicom/quicksave-shared` and `@sumicom/quicksave` to npm when version tags are pushed.

**Architecture:** GitHub Actions workflow triggered by `v*` tags. Uses npm Trusted Publishers (OIDC) for authentication - no secrets needed. Publishes shared package first (agent depends on it), then agent.

**Tech Stack:** GitHub Actions, pnpm, npm OIDC provenance

---

## Task 1: Create the Publish Workflow

**Files:**
- Create: `.github/workflows/publish.yml`

**Step 1: Create the workflow file**

```yaml
name: Publish to npm

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v2
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          registry-url: 'https://registry.npmjs.org'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      - name: Test
        run: pnpm test

      - name: Publish @sumicom/quicksave-shared
        run: pnpm --filter @sumicom/quicksave-shared publish --provenance --access public --no-git-checks

      - name: Publish @sumicom/quicksave
        run: pnpm --filter @sumicom/quicksave publish --provenance --access public --no-git-checks
```

**Step 2: Verify workflow syntax**

Run: `cat .github/workflows/publish.yml | head -20`
Expected: Shows the workflow header with correct `on: push: tags: ['v*']` trigger

---

## Task 2: Update Agent package.json for npm Publishing

**Files:**
- Modify: `apps/agent/package.json`

**Step 1: Add required npm fields**

Add these fields to `apps/agent/package.json`:

```json
{
  "name": "@sumicom/quicksave",
  "version": "0.1.0",
  "description": "Quicksave agent - remote git control CLI",
  "repository": {
    "type": "git",
    "url": "https://github.com/KingYoung-Sumicom/quicksave.git",
    "directory": "apps/agent"
  },
  "homepage": "https://github.com/KingYoung-Sumicom/quicksave#readme",
  "bugs": {
    "url": "https://github.com/KingYoung-Sumicom/quicksave/issues"
  },
  "keywords": ["git", "cli", "remote", "quicksave"],
  "files": ["dist", "README.md"],
  ...existing fields...
}
```

**Step 2: Verify package.json is valid**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('apps/agent/package.json')).name)"`
Expected: `@sumicom/quicksave`

---

## Task 3: Update Shared package.json for npm Publishing

**Files:**
- Modify: `packages/shared/package.json`

**Step 1: Add required npm fields**

Add these fields to `packages/shared/package.json`:

```json
{
  "name": "@sumicom/quicksave-shared",
  "version": "0.1.0",
  "description": "Shared types and utilities for Quicksave",
  "repository": {
    "type": "git",
    "url": "https://github.com/KingYoung-Sumicom/quicksave.git",
    "directory": "packages/shared"
  },
  "homepage": "https://github.com/KingYoung-Sumicom/quicksave#readme",
  "bugs": {
    "url": "https://github.com/KingYoung-Sumicom/quicksave/issues"
  },
  "keywords": ["quicksave", "shared", "types"],
  "files": ["dist"],
  ...existing fields...
}
```

**Step 2: Verify package.json is valid**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('packages/shared/package.json')).name)"`
Expected: `@sumicom/quicksave-shared`

---

## Task 4: Test Build Locally

**Step 1: Run full build**

Run: `pnpm build`
Expected: Both packages build successfully

**Step 2: Run tests**

Run: `pnpm test`
Expected: All tests pass

**Step 3: Verify dist folders exist**

Run: `ls packages/shared/dist/index.js apps/agent/dist/index.js`
Expected: Both files exist

---

## Task 5: Configure npm Trusted Publishers (Manual)

**This is done on npmjs.com, not in code.**

**Step 1: Configure for @sumicom/quicksave-shared**

1. Go to npmjs.com → @sumicom/quicksave-shared → Settings → Publishing access
2. Add GitHub Actions:
   - Repository: `KingYoung-Sumicom/quicksave`
   - Workflow: `publish.yml`
   - Environment: *(leave blank)*

**Step 2: Configure for @sumicom/quicksave**

1. Go to npmjs.com → @sumicom/quicksave → Settings → Publishing access
2. Add GitHub Actions:
   - Repository: `KingYoung-Sumicom/quicksave`
   - Workflow: `publish.yml`
   - Environment: *(leave blank)*

---

## Task 6: Test the Workflow (Dry Run)

**Step 1: Create a test tag**

```bash
# Bump versions in both package.json files to 0.1.1
git add -A
git commit -m "chore: bump version to 0.1.1"
git tag v0.1.1
git push origin stable --tags
```

**Step 2: Monitor GitHub Actions**

Go to: `https://github.com/KingYoung-Sumicom/quicksave/actions`
Expected: Workflow runs and publishes both packages

**Step 3: Verify on npm**

Run: `npm view @sumicom/quicksave-shared version`
Expected: `0.1.1`

Run: `npm view @sumicom/quicksave version`
Expected: `0.1.1`
