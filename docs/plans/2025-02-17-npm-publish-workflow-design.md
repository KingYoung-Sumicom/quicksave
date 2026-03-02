# npm Publish Workflow Design

## Overview

Automate building and publishing `@sumicom/quicksave-shared` and `@sumicom/quicksave` packages to npm when version tags are pushed to the `stable` branch.

## Approach

**Tag-Based Publishing with npm Trusted Publishers (OIDC)**

- Push a tag like `v1.2.3` triggers GitHub Actions
- Builds both packages in dependency order (shared first, then agent)
- Publishes to npm via OIDC (no NPM_TOKEN secret needed)
- Both packages share unified versioning

## Workflow

```
Push tag v1.2.3 to stable branch
         |
         v
GitHub Actions triggers publish.yml
         |
         v
Build packages (shared first, then agent)
         |
         v
Run tests
         |
         v
Publish to npm via OIDC
```

## Implementation

### File: `.github/workflows/publish.yml`

```yaml
name: Publish to npm
on:
  push:
    tags: ['v*']

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write  # Required for npm OIDC
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
        with:
          version: 8
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
          registry-url: 'https://registry.npmjs.org'
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test
      - run: pnpm --filter @sumicom/quicksave-shared publish --provenance --access public --no-git-checks
      - run: pnpm --filter @sumicom/quicksave publish --provenance --access public --no-git-checks
```

### npm Trusted Publisher Configuration

Configure on npmjs.com for each package:

| Setting | Value |
|---------|-------|
| Repository | `KingYoung-Sumicom/quicksave` |
| Workflow | `publish.yml` |
| Environment | *(blank)* |

### Release Process

1. Update version in both `package.json` files
2. Commit: `git commit -am "chore: bump version to X.Y.Z"`
3. Tag: `git tag vX.Y.Z`
4. Push: `git push origin stable --tags`

## Dependencies

- `@sumicom/quicksave` depends on `@sumicom/quicksave-shared` via `workspace:*`
- Publishing shared first ensures the dependency is available on npm
- Both packages use the same version number
