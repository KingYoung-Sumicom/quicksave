// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Manual smoke test for Phase 1 of the codex app-server migration.
 *
 *   npx tsx apps/agent/scripts/smoke-app-server.ts
 *
 * Spawns `codex app-server` (stdio), runs `initialize` + `initialized`,
 * prints the InitializeResponse, then shuts down. Confirms the RPC
 * client + process manager + handshake round-trip with a real server.
 *
 * Exit code: 0 on success, 1 on any failure.
 */
import { spawnAppServer } from '../src/ai/codexAppServer/index.js';

async function main(): Promise<void> {
  const log = {
    warn: (msg: string) => console.warn('[warn]', msg),
    info: (msg: string) => console.log('[info]', msg),
  };

  console.log('Spawning codex app-server …');
  const handle = await spawnAppServer(
    {
      clientInfo: {
        name: 'quicksave-agent-smoke',
        title: null,
        version: '0.0.0',
      },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: null,
      },
    },
    { log },
  );

  console.log('cliVersion:', handle.cliVersion);
  console.log('initializeResponse:', JSON.stringify(handle.initializeResponse, null, 2));

  console.log('Shutting down …');
  await handle.shutdown();
  console.log('Done.');
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
