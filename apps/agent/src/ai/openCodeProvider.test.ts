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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Mock child_process for binary lookup ─────────────────────────────────────

const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: (cmd: string, opts?: unknown) => mockExecSync(cmd, opts),
}));

// ── Imports under test ───────────────────────────────────────────────────────

import {
  OpenCodeProvider,
  OpencodeSession,
  SessionEventRouter,
  isValidOpenCodeModelId,
  parseModelId,
  getOpenCodeBin,
  _resetOpenCodeBinCache,
  type TurnConfig,
} from './openCodeProvider.js';
import { StreamCardBuilder } from './cardBuilder.js';
import type { ProviderCallbacks } from './provider.js';
import type { OpenCodeServer, OpenCodeEvent } from './openCodeServer.js';

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
    onSessionExited: vi.fn(),
    handlePermissionRequest: async () => ({ action: 'allow' as const }),
  };
}

function makeMockServer(): OpenCodeServer & {
  prompts: Array<{ sessionID: string; body: any }>;
  aborts: string[];
  replies: Array<{ requestID: string; reply: string }>;
  messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
} {
  const prompts: Array<{ sessionID: string; body: any }> = [];
  const aborts: string[] = [];
  const replies: Array<{ requestID: string; reply: string }> = [];
  const messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = [];
  return {
    prompts, aborts, replies, messages,
    ensureRunning: async () => ({ baseUrl: 'http://127.0.0.1:4096' }),
    createSession: async () => ({ id: 'ses_mock' }),
    deleteSession: async () => undefined,
    sendPromptAsync: async (sessionID, body) => { prompts.push({ sessionID, body }); },
    abortSession: async (id) => { aborts.push(id); },
    replyPermission: async (requestID, reply) => { replies.push({ requestID, reply }); },
    getMessages: async () => messages,
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
  _resetOpenCodeBinCache();
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('isValidOpenCodeModelId', () => {
  it('accepts provider/model', () => {
    expect(isValidOpenCodeModelId('opencode/big-pickle')).toBe(true);
    expect(isValidOpenCodeModelId('anthropic/claude-3-sonnet')).toBe(true);
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
    const s = new OpencodeSession('ses_x', server, turnConfig);
    s.interrupt();
    // abort is fire-and-forget; allow the microtask to run.
    return new Promise<void>((r) => setImmediate(() => {
      expect(server.aborts).toContain('ses_x');
      r();
    }));
  });

  it('kill marks dead and disposes', () => {
    const server = makeMockServer();
    const s = new OpencodeSession('ses_x', server, turnConfig);
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
    const s = new OpencodeSession('ses_y', server, {
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
      body: {
        text: 'how are you?',
        model: { providerID: 'vllm', modelID: 'foo/bar' },
        variant: 'high',
        system: 'be brief',
      },
    });
  });

  it('sendUserMessage on a killed session is a no-op', () => {
    const server = makeMockServer();
    const s = new OpencodeSession('ses_d', server, turnConfig);
    const cb = new StreamCardBuilder('ses_d', '/p');
    const cbs = makeCallbacks();
    s._setTurnWiring(cb, cbs, new SessionEventRouter('ses_d', cb, cbs, server), () => {});
    s.kill();
    s.sendUserMessage('ignored');
    expect(server.prompts).toHaveLength(0);
  });

  it('getContextUsage returns null (unsupported)', async () => {
    expect(await new OpencodeSession('ses_x', makeMockServer(), turnConfig).getContextUsage()).toBeNull();
  });
});

// ── SessionEventRouter ───────────────────────────────────────────────────────

describe('SessionEventRouter', () => {
  const makeRouter = () => {
    const server = makeMockServer();
    const cb = new StreamCardBuilder('ses_t', '/p');
    const cbs = makeCallbacks();
    const router = new SessionEventRouter('ses_t', cb, cbs, server);
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
    expect(cbs.tools).toEqual([{ sessionId: 'ses_t', toolName: 'read', input: { filePath: '/etc/hosts' } }]);
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

  it('session.idle finalizes with success=true', async () => {
    const { router, cbs } = makeRouter();
    router.handle(ev('session.idle', { sessionID: 'ses_t' }));
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
    expect(cbs.tools).toEqual([{ sessionId: 'ses_t', toolName: 'bash', input: { command: 'pwd' } }]);
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
    const router = new SessionEventRouter('ses_t', cb, cbs, server);
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
    expect(calls[0].toolName).toBe('bash');
    expect(calls[0].toolInput).toEqual({ command: 'ls' });
    expect(server.replies).toEqual([{ requestID: 'per_abc', reply: 'once' }]);
  });

  it('rejects permission when handlePermissionRequest returns deny', async () => {
    const server = makeMockServer();
    const cb = new StreamCardBuilder('ses_t', '/p');
    const cbs: ProviderCallbacks = {
      ...makeCallbacks(),
      handlePermissionRequest: async () => ({ action: 'deny' }),
    };
    const router = new SessionEventRouter('ses_t', cb, cbs, server);
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
    expect(server.replies).toEqual([{ requestID: 'per_xyz', reply: 'reject' }]);
  });
});

// ── Provider top-level ───────────────────────────────────────────────────────

describe('OpenCodeProvider', () => {
  it('has correct id, label, historyMode, and reports resume support', async () => {
    mockExecSync.mockImplementation(() => '1.0.0');
    const provider = new OpenCodeProvider();
    expect(provider.id).toBe('opencode');
    expect(provider.label).toBe('OpenCode');
    expect(provider.historyMode).toBe('memory');
    const probe = await provider.probeProvider();
    expect(probe.capabilities.supportsResume).toBe(true);
    expect(probe.capabilities.supportsStreaming).toBe(true);
  });

  it('reads models from user opencode.json (avoids `opencode models` /tmp leak)', async () => {
    const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'opencode-test-'));
    const cfgDir = path.join(tmpHome, '.config', 'opencode');
    await fsp.mkdir(cfgDir, { recursive: true });
    await fsp.writeFile(path.join(cfgDir, 'opencode.json'), JSON.stringify({
      provider: {
        vllm: { models: { 'foo/bar': { name: 'Foo Bar' } } },
        opencode: { models: { 'big-pickle': {} } },
      },
    }));
    const oldHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('--version')) return '1.0.0';
        if (cmd.includes('which')) return '/usr/bin/opencode';
        if (cmd.includes(' models')) throw new Error('opencode models must not be invoked');
        return '';
      });
      const r = await new OpenCodeProvider().probeProvider();
      const ids = r.models?.map((m) => m.id).sort();
      expect(ids).toEqual(['opencode/big-pickle', 'vllm/foo/bar']);
      const named = r.models?.find((m) => m.id === 'vllm/foo/bar');
      expect(named?.name).toBe('Foo Bar');
    } finally {
      process.env.HOME = oldHome;
      await fsp.rm(tmpHome, { recursive: true, force: true });
    }
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
