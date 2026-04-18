// Mirror scripts/dev-daemon.sh's dev-marker.mjs injection so tests run with
// isDev() === true. Production-path behavior is covered by a flag-flip inside
// the relevant tests, not by running all tests under the prod branch.
(globalThis as { __QUICKSAVE_DEV__?: boolean }).__QUICKSAVE_DEV__ = true;
