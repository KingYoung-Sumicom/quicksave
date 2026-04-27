# Testing Guidelines

## Core Principle

Write tests in the same pass as the code. Do not defer testing to a separate batch.

When implementing a feature or fixing a bug, write or update the corresponding tests before considering the task done. Tests written later tend to verify current behavior rather than intended behavior, allowing bugs to hide.

## Agent Tests (`apps/agent`)

### Running

```bash
cd apps/agent && npx vitest run            # Run all tests
cd apps/agent && npx vitest run --coverage  # Run with coverage report
cd apps/agent && npx vitest run src/ai/cardBuilder.test.ts  # Run specific file
```

### Structure

- Test files live alongside source: `foo.ts` → `foo.test.ts`
- Vitest with globals enabled — no need to import `describe`/`it`/`expect`
- Node.js environment
- Coverage via `@vitest/coverage-v8`

### What to Test

1. **Unit tests** — Pure logic, state management, data transformations.
   - cardBuilder: card event generation, state tracking
   - sessionManager: session lifecycle, permission logic, event emission
   - sessionRegistry: CRUD, persistence round-trips
   - pubsub: subscription routing, cleanup
   - config: path resolution, env handling

2. **Adversarial / edge-case tests** — Specifically try to break the code.
   - Race conditions (e.g., clearCards before snapshotCutoff)
   - State after reconnect (e.g., pubsub subscriptions lost)
   - Missing or out-of-order events
   - Put these in a dedicated `edgeCases.test.ts` or alongside the relevant module

3. **Integration tests** — Cross-module flows with real filesystem.
   - git operations (uses temp repos)
   - IPC client/server (uses real Unix sockets)

### Mocking

- Use `vi.mock()` for external dependencies (filesystem, providers, crypto)
- Mock providers heavily — never spawn real Claude processes in tests
- For filesystem tests, use temp directories (`mkdtemp`) with cleanup in `afterEach`

### When Fixing Bugs

1. Write a test that reproduces the bug first (red)
2. Fix the bug (green)
3. If the bug involves a race condition, write an adversarial test that exposes the timing window, with a `// BUG:` comment if the fix is only partial

## PWA Tests (`apps/pwa`)

Currently type-checked only:

```bash
cd apps/pwa && npx tsc --noEmit
```

## Continuous Process Refinement

Testing practices should evolve alongside the codebase. When a bug is found in production or during development:

1. **Ask why the existing tests didn't catch it.** Was it a missing test, a wrong assertion, or an untested edge case?
2. **Add a regression test** that would have caught it.
3. **Update these guidelines** if the bug reveals a pattern worth documenting (e.g., "always test reconnect behavior when modifying pubsub").

When a batch of tests is written retroactively (as opposed to alongside code), review whether any tests expose real bugs. Tests that only verify current behavior are useful for regression, but adversarial tests that challenge assumptions are where real value is found.

Periodically review coverage reports to identify blind spots. Prioritize testing modules with high change frequency over stable ones.

## Coverage Targets

Current baseline (2026-04-14): 45% statements, 61% functions, 333 tests.

Priority modules for coverage improvement:
- Providers (claudeCliProvider, claudeSdkProvider, codexAppServer/*) — lowest coverage, hardest to test
- messageHandler — 38% coverage, room for improvement
- Entry points (run.ts, index.ts) — integration-level, lower priority
