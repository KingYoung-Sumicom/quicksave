/**
 * End-to-end smoke for the codex app-server provider.
 *
 *   npx tsx apps/agent/scripts/smoke-app-server-turn.ts
 *
 * Drives `CodexAppServerProvider` through the same flow SessionManager
 * uses: startSession → wait for turn/completed → print collected
 * cards. Requires the local `codex` CLI to be authenticated (ChatGPT
 * login or OPENAI_API_KEY env var).
 *
 * Exit code: 0 on success, 1 on any failure.
 */
import { CodexAppServerProvider } from '../src/ai/codexAppServer/index.js';
import { StreamCardBuilder } from '../src/ai/cardBuilder.js';
import type { ProviderCallbacks } from '../src/ai/provider.js';
import type { CardEvent, CardStreamEnd } from '@sumicom/quicksave-shared';

async function main(): Promise<void> {
  const provider = new CodexAppServerProvider();
  const cb = new StreamCardBuilder('pending', 's_smoke', process.cwd());

  const events: CardEvent[] = [];
  let streamEnd: CardStreamEnd | null = null;
  const done = new Promise<void>((resolve) => {
    const cb_resolve = (): void => resolve();
    const callbacks: ProviderCallbacks = {
      emitCardEvent: (e) => events.push(e),
      emitStreamEnd: (e) => {
        streamEnd = e;
        cb_resolve();
      },
      handlePermissionRequest: async () => ({ action: 'allow' as const }),
      onModelDetected: (m) => console.log('[model]', m),
    };
    void runSession(provider, cb, callbacks);
  });

  await Promise.race([done, timeout(60_000)]);

  console.log('=== Cards ===');
  for (const e of events) {
    if (e.type === 'add') {
      const card = (e as { card: { type: string; text?: string; toolName?: string } }).card;
      const preview = card.text ?? card.toolName ?? '?';
      console.log(`  [${card.type}]`, preview.slice(0, 80));
    } else if (e.type === 'append_text') {
      // Skip — already accounted for in summary below.
    } else if (e.type === 'update') {
      console.log(`  [update ${e.cardId}]`, JSON.stringify(e.patch).slice(0, 80));
    }
  }
  console.log('=== Stream end ===');
  console.log(JSON.stringify(streamEnd, null, 2));

  if (!streamEnd) {
    console.error('FAILED: no stream end emitted');
    process.exit(1);
  }
  if (!streamEnd.success) {
    console.error('FAILED: stream end success=false:', streamEnd.error);
    process.exit(1);
  }
  console.log('OK');
}

async function runSession(
  provider: CodexAppServerProvider,
  cb: StreamCardBuilder,
  callbacks: ProviderCallbacks,
): Promise<void> {
  try {
    const result = await provider.startSession(
      {
        prompt: 'Reply with the single word: pong',
        cwd: process.cwd(),
        permissionLevel: 'plan',
        sandboxed: true,
        model: undefined,
      },
      cb,
      callbacks,
    );
    console.log('[session]', result.sessionId);
    // Wait long enough for the turn to complete; SessionManager's run.ts
    // also attaches a similar 'session-exited' listener but we just rely
    // on the stream-end resolution.
    void result;
  } catch (err) {
    console.error('startSession failed:', err);
    process.exit(1);
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
  );
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
