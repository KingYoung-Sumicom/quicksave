/**
 * Tests for the Codex models cache + fs.watch behavior on MessageHandler.
 *
 * These exercise the public API surface only:
 *   - constructor(options.codexCacheDir)
 *   - startCodexModelsWatcher / stopCodexModelsWatcher
 *   - getCachedCodexModels
 *   - setCodexModelsUpdateHandler
 *   - handleMessage('codex:list-models')
 *   - cleanup
 *
 * Real fs.watch + real temp dirs are used; we just sleep ~700-800ms to let
 * the internal debounce + refresh resolve. The CLI-spawning providers are
 * stubbed so no real `claude` / `codex` processes are forked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageHandler } from './messageHandler.js';
import { createMessage } from '@sumicom/quicksave-shared';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { simpleGit } from 'simple-git';
import { resetSessionRegistry } from '../ai/sessionRegistry.js';
import { setQuicksaveDir } from '../service/singleton.js';

// Stub the CLI-spawning providers so these tests don't fork real CLIs.
const makeMockSession = () => ({
  sendUserMessage: vi.fn(),
  interrupt: vi.fn(),
  kill: vi.fn(),
  alive: true,
});
vi.mock('../ai/claudeCodeProvider.js', () => ({
  ClaudeCodeProvider: vi.fn().mockImplementation(() => ({
    id: 'claude-code' as const,
    historyMode: 'claude-jsonl' as const,
    startSession: vi.fn().mockImplementation(async () => ({
      sessionId: `mock-${Math.random().toString(36).slice(2, 10)}`,
      session: makeMockSession(),
    })),
    resumeSession: vi.fn().mockImplementation(async (opts: { sessionId?: string }) => ({
      sessionId: opts.sessionId ?? `mock-${Math.random().toString(36).slice(2, 10)}`,
      session: makeMockSession(),
    })),
  })),
}));
vi.mock('../ai/codexSdkProvider.js', () => ({
  CodexSdkProvider: vi.fn().mockImplementation(() => ({
    id: 'codex' as const,
    historyMode: 'memory' as const,
    startSession: vi.fn().mockImplementation(async () => ({
      sessionId: `mock-codex-${Math.random().toString(36).slice(2, 10)}`,
      session: makeMockSession(),
    })),
    resumeSession: vi.fn().mockImplementation(async (opts: { sessionId?: string }) => ({
      sessionId: opts.sessionId ?? `mock-codex-${Math.random().toString(36).slice(2, 10)}`,
      session: makeMockSession(),
    })),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestRepo(suffix = ''): Promise<string> {
  const repoPath = join(
    tmpdir(),
    `qs-codex-watcher-repo-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(repoPath, { recursive: true });
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@test.com');
  await git.addConfig('user.name', 'Test User');
  await writeFile(join(repoPath, 'README.md'), '# Test Repo\n');
  await git.add('README.md');
  await git.commit('Initial commit');
  return repoPath;
}

function uniqueDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

type CacheEntry = {
  slug: string;
  display_name: string;
  visibility: 'list' | 'hide';
  supported_in_api: boolean;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  context_window?: number;
};

async function writeModelsCache(dir: string, models: CacheEntry[]): Promise<void> {
  await writeFile(
    join(dir, 'models_cache.json'),
    JSON.stringify({ models }),
    'utf-8',
  );
}

/**
 * Create an executable shell script that, when invoked with `debug models`,
 * prints the given JSON to stdout and exits 0. Mimics the real `codex`
 * binary's `debug models` subcommand for deterministic testing.
 */
async function writeFakeCodexCli(
  path: string,
  models: CacheEntry[] | null,
  exitCode = 0,
): Promise<void> {
  const json = models === null ? 'not-json' : JSON.stringify({ models });
  const script = `#!/usr/bin/env bash
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  cat <<'EOF'
${json}
EOF
  exit ${exitCode}
fi
exit 1
`;
  await writeFile(path, script, { encoding: 'utf-8', mode: 0o755 });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageHandler — Codex models watcher', () => {
  let repoPath: string;
  let testQuicksaveDir: string;
  let codexCacheDir: string;
  let handler: MessageHandler | null = null;
  const peerA = 'pwa:peerA';

  beforeEach(async () => {
    testQuicksaveDir = uniqueDir('qs-codex-watcher-home');
    await mkdir(testQuicksaveDir, { recursive: true });
    setQuicksaveDir(testQuicksaveDir);
    resetSessionRegistry();
    repoPath = await createTestRepo('main');
    codexCacheDir = uniqueDir('qs-codex-watcher');
    // NOTE: do NOT mkdir codexCacheDir here — individual tests decide whether
    // it exists, so we can cover the missing-directory tolerance scenario.
    handler = null;
  });

  afterEach(async () => {
    resetSessionRegistry();
    if (handler) {
      try { handler.stopCodexModelsWatcher(); } catch { /* ignore */ }
      try { handler.cleanup(); } catch { /* ignore */ }
      handler = null;
    }
    try { await rm(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { await rm(testQuicksaveDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { await rm(codexCacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // 1. startCodexModelsWatcher primes the cache from an existing file
  // -------------------------------------------------------------------------
  it('startCodexModelsWatcher primes the cache from an existing models_cache.json', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list', supported_in_api: true },
      { slug: 'o4-mini', display_name: 'o4 mini', visibility: 'list', supported_in_api: true },
    ]);

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: null },
    );

    handler.startCodexModelsWatcher();
    // Allow the priming fetchCodexModels() promise to resolve. It does a real
    // fs read so we just yield a few microtasks + a short tick.
    await sleep(100);

    const cached = handler.getCachedCodexModels();
    expect(cached).toEqual([
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'o4-mini', name: 'o4 mini' },
    ]);
  });

  // -------------------------------------------------------------------------
  // 2. Watcher fires update handler when content changes
  // -------------------------------------------------------------------------
  it('fires the update handler when models_cache.json content changes', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list', supported_in_api: true },
      { slug: 'o4-mini', display_name: 'o4 mini', visibility: 'list', supported_in_api: true },
    ]);

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: null },
    );
    handler.startCodexModelsWatcher();
    await sleep(100); // let prime resolve

    const updateHandler = vi.fn();
    handler.setCodexModelsUpdateHandler(updateHandler);

    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list', supported_in_api: true },
      { slug: 'o4-mini', display_name: 'o4 mini', visibility: 'list', supported_in_api: true },
      { slug: 'gpt-6', display_name: 'GPT-6', visibility: 'list', supported_in_api: true },
    ]);

    await sleep(800); // 500ms debounce + refresh + handler invoke

    expect(updateHandler).toHaveBeenCalledTimes(1);
    expect(updateHandler).toHaveBeenCalledWith([
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'o4-mini', name: 'o4 mini' },
      { id: 'gpt-6', name: 'GPT-6' },
    ]);
  });

  // -------------------------------------------------------------------------
  // 3. Watcher dedups identical content
  // -------------------------------------------------------------------------
  it('does not fire the update handler when content is unchanged', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    const initial: CacheEntry[] = [
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list', supported_in_api: true },
      { slug: 'o4-mini', display_name: 'o4 mini', visibility: 'list', supported_in_api: true },
    ];
    await writeModelsCache(codexCacheDir, initial);

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: null },
    );
    handler.startCodexModelsWatcher();
    await sleep(100);

    const updateHandler = vi.fn();
    handler.setCodexModelsUpdateHandler(updateHandler);

    // Rewrite identical content — should still fire fs.watch but the
    // refresh's equality check should suppress the handler call.
    await writeModelsCache(codexCacheDir, initial);

    await sleep(800);

    expect(updateHandler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. Debounce coalesces rapid writes
  // -------------------------------------------------------------------------
  it('coalesces rapid successive writes into a single update', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list', supported_in_api: true },
      { slug: 'o4-mini', display_name: 'o4 mini', visibility: 'list', supported_in_api: true },
    ]);

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: null },
    );
    handler.startCodexModelsWatcher();
    await sleep(100);

    const updateHandler = vi.fn();
    handler.setCodexModelsUpdateHandler(updateHandler);

    // Three rapid writes; only the FINAL content should drive the update.
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list', supported_in_api: true },
    ]);
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list', supported_in_api: true },
      { slug: 'o4-mini', display_name: 'o4 mini', visibility: 'list', supported_in_api: true },
    ]);
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list', supported_in_api: true },
      { slug: 'o4-mini', display_name: 'o4 mini', visibility: 'list', supported_in_api: true },
      { slug: 'gpt-6', display_name: 'GPT-6', visibility: 'list', supported_in_api: true },
    ]);

    await sleep(900);

    expect(updateHandler).toHaveBeenCalledTimes(1);
    expect(updateHandler).toHaveBeenCalledWith([
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'o4-mini', name: 'o4 mini' },
      { id: 'gpt-6', name: 'GPT-6' },
    ]);
  });

  // -------------------------------------------------------------------------
  // 5. Filters hidden / non-API models
  // -------------------------------------------------------------------------
  it('filters out hidden and non-API-supported models', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list', supported_in_api: true },
      { slug: 'codex-internal', display_name: 'Codex Internal', visibility: 'hide', supported_in_api: true },
      { slug: 'o4-no-api', display_name: 'o4 No API', visibility: 'list', supported_in_api: false },
    ]);

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: null },
    );
    handler.startCodexModelsWatcher();
    await sleep(100);

    const cached = handler.getCachedCodexModels();
    expect(cached).toEqual([{ id: 'gpt-5', name: 'GPT-5' }]);
  });

  // -------------------------------------------------------------------------
  // 6. Tolerant of missing ~/.codex directory
  // -------------------------------------------------------------------------
  it('does not throw when codexCacheDir does not exist; cache stays empty', async () => {
    // codexCacheDir was set in beforeEach but intentionally NOT created.
    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: null },
    );

    expect(() => handler!.startCodexModelsWatcher()).not.toThrow();

    // Give the priming fetch a chance to resolve (it'll fail to read).
    await sleep(100);

    expect(handler.getCachedCodexModels()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 7. stopCodexModelsWatcher is idempotent + suppresses post-stop updates
  // -------------------------------------------------------------------------
  it('stopCodexModelsWatcher is idempotent and prevents subsequent handler invocations', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list', supported_in_api: true },
    ]);

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: null },
    );
    handler.startCodexModelsWatcher();
    await sleep(100);

    const updateHandler = vi.fn();
    handler.setCodexModelsUpdateHandler(updateHandler);

    // Idempotent stop
    expect(() => {
      handler!.stopCodexModelsWatcher();
      handler!.stopCodexModelsWatcher();
    }).not.toThrow();

    // Now write new content; nothing should fire because the watcher is gone.
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list', supported_in_api: true },
      { slug: 'gpt-6', display_name: 'GPT-6', visibility: 'list', supported_in_api: true },
    ]);

    await sleep(800);

    expect(updateHandler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8. codex:list-models response uses the cached models
  // -------------------------------------------------------------------------
  it('codex:list-models response surfaces the primed cache', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list', supported_in_api: true },
      { slug: 'o4-mini', display_name: 'o4 mini', visibility: 'list', supported_in_api: true },
    ]);

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: null },
    );
    handler.startCodexModelsWatcher();
    await sleep(100);

    const msg = createMessage('codex:list-models', {} as any);
    const resp = await handler.handleMessage(msg, peerA);
    expect(resp.type).toBe('codex:list-models:response');
    const payload = resp.payload as { models: Array<{ id: string; name: string }> };
    expect(payload.models).toEqual([
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'o4-mini', name: 'o4 mini' },
    ]);
  });

  // -------------------------------------------------------------------------
  // 9. `codex debug models` is preferred over the cache file
  // -------------------------------------------------------------------------
  it('uses `codex debug models` output when the CLI is available', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    // Cache file deliberately missing the new model — this is the bug we fix.
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', supported_in_api: true },
    ]);
    const fakeBin = join(codexCacheDir, 'fake-codex.sh');
    await writeFakeCodexCli(fakeBin, [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_in_api: true },
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', supported_in_api: true },
    ]);

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: fakeBin },
    );
    handler.startCodexModelsWatcher();
    await sleep(300); // CLI spawn + JSON parse

    expect(handler.getCachedCodexModels()).toEqual([
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
    ]);
  });

  // -------------------------------------------------------------------------
  // 10. Falls back to cache file when the CLI exits non-zero
  // -------------------------------------------------------------------------
  it('falls back to the cache file when `codex debug models` fails', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', supported_in_api: true },
    ]);
    const fakeBin = join(codexCacheDir, 'fake-codex.sh');
    await writeFakeCodexCli(fakeBin, [], 1); // exit non-zero

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: fakeBin },
    );
    handler.startCodexModelsWatcher();
    await sleep(300);

    expect(handler.getCachedCodexModels()).toEqual([
      { id: 'gpt-5.4', name: 'GPT-5.4' },
    ]);
  });

  // -------------------------------------------------------------------------
  // 11. Falls back when CLI binary doesn't exist (ENOENT)
  // -------------------------------------------------------------------------
  it('falls back to the cache file when the codex binary is missing', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', supported_in_api: true },
    ]);

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: '/nonexistent/codex-binary' },
    );
    handler.startCodexModelsWatcher();
    await sleep(300);

    expect(handler.getCachedCodexModels()).toEqual([
      { id: 'gpt-5.4', name: 'GPT-5.4' },
    ]);
  });

  // -------------------------------------------------------------------------
  // 12. CLI source filters hidden / non-API models the same as the cache file
  // -------------------------------------------------------------------------
  it('CLI source applies the same visibility/api filter as the cache file', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    const fakeBin = join(codexCacheDir, 'fake-codex.sh');
    await writeFakeCodexCli(fakeBin, [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_in_api: true },
      { slug: 'codex-internal', display_name: 'Codex Internal', visibility: 'hide', supported_in_api: true },
      { slug: 'gpt-5.4-no-api', display_name: 'No API', visibility: 'list', supported_in_api: false },
    ]);

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: fakeBin },
    );
    handler.startCodexModelsWatcher();
    await sleep(300);

    expect(handler.getCachedCodexModels()).toEqual([
      { id: 'gpt-5.5', name: 'GPT-5.5' },
    ]);
  });

  // -------------------------------------------------------------------------
  // 13. Surfaces per-model context_window + reasoning levels
  // -------------------------------------------------------------------------
  it('surfaces context_window, default_reasoning_level, supported_reasoning_levels', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    await writeModelsCache(codexCacheDir, [
      {
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        visibility: 'list',
        supported_in_api: true,
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [
          { effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' },
        ],
        context_window: 272000,
      },
    ]);

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: null },
    );
    handler.startCodexModelsWatcher();
    await sleep(100);

    expect(handler.getCachedCodexModels()).toEqual([
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
        contextWindow: 272000,
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // 14. Bad JSON from CLI degrades to cache file
  // -------------------------------------------------------------------------
  it('falls back when CLI prints non-JSON output', async () => {
    await mkdir(codexCacheDir, { recursive: true });
    await writeModelsCache(codexCacheDir, [
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', supported_in_api: true },
    ]);
    const fakeBin = join(codexCacheDir, 'fake-codex.sh');
    await writeFakeCodexCli(fakeBin, null); // null → script prints "not-json"

    handler = new MessageHandler(
      [{ path: repoPath, name: 'test-repo' }],
      undefined,
      undefined,
      false,
      { codexCacheDir, codexBin: fakeBin },
    );
    handler.startCodexModelsWatcher();
    await sleep(300);

    expect(handler.getCachedCodexModels()).toEqual([
      { id: 'gpt-5.4', name: 'GPT-5.4' },
    ]);
  });
});
