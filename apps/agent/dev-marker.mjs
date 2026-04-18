// Loaded via `node --import` from scripts/dev-daemon.sh before any app code.
// Sets a runtime-only global that src/service/types.ts reads to gate
// dev-only behavior (debug CLI/HTTP, source-mtime BUILD_ID, self-restart on
// code change). Putting the signal here decouples dev detection from the
// brittle `__BUILD_ID__` placeholder-replacement heuristic, which has silently
// broken twice when the bundler config drifted.
globalThis.__QUICKSAVE_DEV__ = true;
