import { describe, expect, it, vi } from 'vitest';
import type { CardEvent, CardStreamEnd, AgentId } from '@sumicom/quicksave-shared';

import { SessionManager } from '../../sessionManager.js';
import type {
  CodingAgentProvider,
  PermissionLevel,
  ProviderCallbacks,
  ProviderHistoryMode,
  ProviderSession,
  ResumeSessionOpts,
  StartSessionOpts,
} from '../../provider.js';
import { StreamCardBuilder } from '../../cardBuilder.js';

/**
 * Stub Codex `app-server` session that records calls SessionManager
 * forwards to it. Mirrors the `CodexAppServerProviderSession`
 * interface duck-typed by SessionManager.
 *
 * `pendingStreamIds` + `sendUserMessage` mirror the real session's
 * shape: the manager pushes the resume's streamId into the queue
 * before calling sendUserMessage; the session shifts it back out when
 * starting the next turn so the emitted cards carry the streamId the
 * PWA's `applySessionCards` filter is watching for.
 */
class StubCodexAppServerSession implements ProviderSession {
  alive = true;
  enqueued: Record<string, unknown>[] = [];
  pendingStreamIds: string[] = [];
  sendUserMessages: Array<{ prompt: string; streamId: string }> = [];
  enqueueRuntimeOverride(patch: Record<string, unknown>): void {
    this.enqueued.push(patch);
  }
  sendUserMessage(prompt: string): void {
    const streamId = this.pendingStreamIds.shift() ?? `s_fallback_${Math.random()}`;
    this.sendUserMessages.push({ prompt, streamId });
  }
  interrupt(): void {
    /* noop */
  }
  kill(): void {
    /* noop */
  }
}

class StubCodexProvider implements CodingAgentProvider {
  readonly id: AgentId = 'codex';
  readonly historyMode: ProviderHistoryMode = 'memory';
  readonly sessions = new Map<string, StubCodexAppServerSession>();
  readonly callbacksBySession = new Map<string, ProviderCallbacks>();
  async startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const sessionId = `thr_${Math.random().toString(36).slice(2, 8)}`;
    const session = new StubCodexAppServerSession();
    this.sessions.set(sessionId, session);
    this.callbacksBySession.set(sessionId, callbacks);
    void opts;
    void cardBuilder;
    return { sessionId, session };
  }
  async resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    const session = new StubCodexAppServerSession();
    this.sessions.set(opts.sessionId, session);
    this.callbacksBySession.set(opts.sessionId, callbacks);
    void cardBuilder;
    return { sessionId: opts.sessionId, session };
  }
}

class StubClaudeProvider implements CodingAgentProvider {
  readonly id: AgentId = 'claude-code';
  readonly historyMode: ProviderHistoryMode = 'claude-jsonl';
  async startSession(): Promise<{ sessionId: string; session: ProviderSession }> {
    throw new Error('not used in this test');
  }
  async resumeSession(): Promise<{ sessionId: string; session: ProviderSession }> {
    throw new Error('not used in this test');
  }
}

async function setupActiveCodexSession(): Promise<{
  sm: SessionManager;
  sessionId: string;
  session: StubCodexAppServerSession;
  codex: StubCodexProvider;
}> {
  const codex = new StubCodexProvider();
  const sm = new SessionManager([new StubClaudeProvider(), codex]);
  const events: CardEvent[] = [];
  const ends: CardStreamEnd[] = [];
  sm.on('card-event', (e) => events.push(e as CardEvent));
  sm.on('card-stream-end', (e) => ends.push(e as CardStreamEnd));
  const sessionId = await sm.startSession({
    prompt: 'hello',
    cwd: '/tmp/test',
    streamId: 's_1',
    permissionMode: 'default',
    sandboxed: true,
    agent: 'codex',
  });
  const session = codex.sessions.get(sessionId);
  if (!session) throw new Error('codex stub did not register session');
  return { sm, sessionId, session, codex };
}

describe('SessionManager → CodexAppServer override forwarding', () => {
  it('setSessionConfig(model) forwards to enqueueRuntimeOverride', async () => {
    const { sm, sessionId, session } = await setupActiveCodexSession();
    await sm.setSessionConfig(sessionId, 'model', 'gpt-5.5');
    expect(session.enqueued).toEqual([{ model: 'gpt-5.5' }]);
  });

  it('setSessionConfig(reasoningEffort) forwards as effort', async () => {
    const { sm, sessionId, session } = await setupActiveCodexSession();
    await sm.setSessionConfig(sessionId, 'reasoningEffort', 'high');
    expect(session.enqueued).toEqual([{ effort: 'high' }]);
  });

  it('setSessionConfig(reasoningEffort=null) forwards null to clear', async () => {
    const { sm, sessionId, session } = await setupActiveCodexSession();
    await sm.setSessionConfig(sessionId, 'reasoningEffort', null);
    expect(session.enqueued).toEqual([{ effort: null }]);
  });

  it('setPermissionLevel forwards approvalPolicy/sandboxPolicy/approvalsReviewer', async () => {
    const { sm, sessionId, session } = await setupActiveCodexSession();
    await sm.setPermissionLevel(sessionId, 'bypassPermissions');
    expect(session.enqueued).toHaveLength(1);
    const patch = session.enqueued[0] as {
      approvalPolicy?: unknown;
      sandboxPolicy?: { type?: string };
      approvalsReviewer?: string;
    };
    expect(patch.approvalPolicy).toBe('never');
    expect(patch.sandboxPolicy?.type).toBe('dangerFullAccess');
    expect(patch.approvalsReviewer).toBe('user');
  });

  it('multiple changes accumulate as separate enqueue calls', async () => {
    const { sm, sessionId, session } = await setupActiveCodexSession();
    await sm.setSessionConfig(sessionId, 'model', 'gpt-5.5');
    await sm.setSessionConfig(sessionId, 'reasoningEffort', 'low');
    await sm.setPermissionLevel(sessionId, 'plan');
    expect(session.enqueued).toHaveLength(3);
    expect(session.enqueued[0]).toMatchObject({ model: 'gpt-5.5' });
    expect(session.enqueued[1]).toMatchObject({ effort: 'low' });
    expect(session.enqueued[2]).toMatchObject({ approvalPolicy: 'on-request' });
  });
});

describe('SessionManager → CodexAppServer hot-resume streamId propagation', () => {
  // Regression: prior to this, the codex app-server session ignored the
  // resume's streamId and minted a fresh `s_${Date.now()}` for every
  // sendUserMessage. The PWA's applySessionCards filter then dropped
  // every card-event whose streamId wasn't in activeStreamIds — making
  // mid-turn assistant text and tool calls invisible until a manual
  // refresh re-pulled them via the cardBuilder snapshot.
  it('active hot-resume pushes the resume streamId into pendingStreamIds', async () => {
    const { sm, sessionId, session } = await setupActiveCodexSession();
    // `streaming=true` is set by setupActiveCodexSession's startSession;
    // resumeSession's active-hot-resume branch fires.
    await sm.resumeSession({
      sessionId,
      prompt: 'follow-up',
      cwd: '/tmp/test',
      streamId: 's_resume_1',
    });
    expect(session.sendUserMessages).toHaveLength(1);
    expect(session.sendUserMessages[0]).toEqual({
      prompt: 'follow-up',
      streamId: 's_resume_1',
    });
  });

  it('idle hot-resume pushes the resume streamId into pendingStreamIds', async () => {
    const { sm, sessionId, session, codex } = await setupActiveCodexSession();
    // Drive the session out of streaming so resumeSession picks the
    // idle-hot-resume branch. Going through emitStreamEnd is the only
    // path that flips ManagedSession.streaming to false externally —
    // matches what consumeAppServerStream's finalize() does in real runs.
    const callbacks = codex.callbacksBySession.get(sessionId);
    if (!callbacks) throw new Error('callbacks missing for stub session');
    callbacks.emitStreamEnd({
      streamId: 's_1',
      sessionId,
      success: true,
    });
    await sm.resumeSession({
      sessionId,
      prompt: 'follow-up-idle',
      cwd: '/tmp/test',
      streamId: 's_resume_2',
    });
    expect(session.sendUserMessages).toHaveLength(1);
    expect(session.sendUserMessages[0]).toEqual({
      prompt: 'follow-up-idle',
      streamId: 's_resume_2',
    });
  });
});

describe('SessionManager — non-codex sessions are unaffected', () => {
  it('setSessionConfig on a session without enqueueRuntimeOverride is a no-op (no throw)', async () => {
    class StubSession implements ProviderSession {
      alive = true;
      sendUserMessage(): void {
        /* noop */
      }
      interrupt(): void {
        /* noop */
      }
      kill(): void {
        /* noop */
      }
    }
    class StubProvider implements CodingAgentProvider {
      readonly id: AgentId = 'codex';
      readonly historyMode: ProviderHistoryMode = 'memory';
      async startSession(): Promise<{ sessionId: string; session: ProviderSession }> {
        return { sessionId: 's_1', session: new StubSession() };
      }
      async resumeSession(): Promise<{ sessionId: string; session: ProviderSession }> {
        return { sessionId: 's_1', session: new StubSession() };
      }
    }
    const sm = new SessionManager([new StubProvider()]);
    const sessionId = await sm.startSession({
      prompt: 'p',
      cwd: '/tmp',
      streamId: 's',
      permissionMode: 'default',
      sandboxed: true,
      agent: 'codex',
    });
    await expect(sm.setSessionConfig(sessionId, 'model', 'gpt-x')).resolves.toBeDefined();
  });
});
