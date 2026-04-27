/**
 * Smoke: does `model/list` work after `initialize` only, without
 * `thread/start`? If yes, we can build the PWA's codex picker from
 * the canonical per-account model list before any session begins.
 *
 *   cd apps/agent && node_modules/.bin/tsx scripts/smoke-model-list.ts
 *
 * Exit 0 on success, 1 on failure.
 */
import { spawnAppServer } from '../src/ai/codexAppServer/processManager.js';

interface Model {
  id: string;
  displayName: string;
  isDefault: boolean;
  hidden: boolean;
}

async function main(): Promise<void> {
  const handle = await spawnAppServer({
    clientInfo: { name: 'quicksave-smoke', title: 'Smoke', version: '0.0.0' },
    capabilities: { experimentalApi: false, optOutNotificationMethods: null },
  });
  try {
    console.log('[smoke] initialize handshake done; calling model/list (no thread)...');
    const res = await handle.rpc.request<{ data: Model[]; nextCursor: string | null }>(
      'model/list',
      { cursor: null, limit: null, includeHidden: true },
    );
    console.log(`[smoke] model/list returned ${res.data.length} models:`);
    for (const m of res.data) {
      const flags: string[] = [];
      if (m.isDefault) flags.push('default');
      if (m.hidden) flags.push('hidden');
      console.log(`  - ${m.id} (${m.displayName})${flags.length ? ` [${flags.join(', ')}]` : ''}`);
    }
    console.log(`[smoke] nextCursor: ${res.nextCursor}`);
    console.log('[smoke] OK — model/list works pre-thread.');
  } catch (err) {
    console.error('[smoke] model/list FAILED:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await handle.shutdown();
  }
}

main().catch((err) => {
  console.error('[smoke] fatal:', err);
  process.exit(1);
});
