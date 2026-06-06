// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
  Card,
  ClaudeUserInputRequestPayload,
  VoiceAgentEvent,
  VoiceConfig,
} from '@sumicom/quicksave-shared';
import { upsertBullet, appendMemory, loadMemory, workspaceMemoryPath } from './memory.js';
import { executeTool, formatCardForBrain, type CodingSessionBridge } from './tools.js';
import { VoiceIntermediarySession } from './session.js';
import { VoiceIntermediaryManager, type VoiceManagerBridge } from './manager.js';

// ── Fakes ───────────────────────────────────────────────────────────────────

interface BridgeCalls {
  send: { sessionId: string; prompt: string; interrupt?: boolean }[];
  interrupt: number;
  resolve: unknown[];
  setPerm: { sessionId: string; level: string }[];
}

function makeBridge(over: {
  cwd?: string;
  open?: boolean;
  cards?: Card[];
  pending?: ClaudeUserInputRequestPayload[];
  perm?: string;
  streaming?: boolean;
} = {}): { bridge: VoiceManagerBridge; calls: BridgeCalls } {
  const calls: BridgeCalls = { send: [], interrupt: 0, resolve: [], setPerm: [] };
  const bridge: VoiceManagerBridge = {
    sendUserMessageToSession: (sessionId, prompt, opts) => {
      calls.send.push({ sessionId, prompt, interrupt: opts?.interrupt });
      return true;
    },
    interruptSession: async () => {
      calls.interrupt++;
      return true;
    },
    resolveUserInput: (r) => {
      calls.resolve.push(r);
      return true;
    },
    setPermissionLevel: async (sessionId, level) => {
      calls.setPerm.push({ sessionId, level });
      return true;
    },
    getCards: async () => ({ cards: over.cards ?? [], total: over.cards?.length ?? 0, hasMore: false }),
    getPendingInputRequests: () => over.pending ?? [],
    getPermissionLevel: () => over.perm ?? 'acceptEdits',
    getActiveSessions: () => [{ sessionId: 's1', isStreaming: over.streaming ?? true }],
    isStreaming: () => over.streaming ?? true,
    getSessionCwd: () => over.cwd,
    isOpen: () => over.open ?? true,
  };
  return { bridge, calls };
}

const CONFIG: VoiceConfig = {
  apiKey: 'k',
  baseUrl: 'http://voice.test/v1',
  mode: 'batch',
  transcribeModel: 'whisper-1',
  streamModel: 'gpt-4o-transcribe',
  agentModel: 'gpt-voice',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
};

/** A scripted OpenAI-compatible endpoint: N chat turns then audio. */
function scriptedFetch(chatTurns: { content?: string; tool?: { name: string; args?: unknown } }[]): typeof fetch {
  let i = 0;
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/chat/completions')) {
      const turn = chatTurns[Math.min(i, chatTurns.length - 1)];
      i++;
      const message: Record<string, unknown> = { content: turn.content ?? '' };
      if (turn.tool) {
        message.tool_calls = [
          { id: `call-${i}`, type: 'function', function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args ?? {}) } },
        ];
      }
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    }
    if (u.endsWith('/audio/speech')) {
      return new Response(Buffer.from([1, 2, 3, 4]), { status: 200 });
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
}

// ── Memory ────────────────────────────────────────────────────────────────

describe('voice memory', () => {
  it('upsertBullet creates, appends, and dedupes', () => {
    let md = upsertBullet('', '專案常識', '測試=pnpm test');
    expect(md).toBe('## 專案常識\n- 測試=pnpm test');
    md = upsertBullet(md, '專案常識', 'lint=eslint');
    expect(md).toContain('- 測試=pnpm test');
    expect(md).toContain('- lint=eslint');
    // duplicate is a no-op
    expect(upsertBullet(md, '專案常識', 'lint=eslint')).toBe(md);
    // a new section is appended
    const withPref = upsertBullet(md, '偏好', '唸重點');
    expect(withPref).toContain('## 偏好');
    expect(withPref).toContain('- 唸重點');
  });

  it('appendMemory writes to the workspace file and loadMemory reads it back', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-mem-'));
    try {
      await appendMemory(cwd, 'push 一律要問我', 'decision');
      const raw = await readFile(workspaceMemoryPath(cwd), 'utf8');
      expect(raw).toContain('## 常駐決定（界線）');
      expect(raw).toContain('- push 一律要問我');

      const loaded = await loadMemory(cwd);
      expect(loaded).toContain('此工作區記憶');
      expect(loaded).toContain('push 一律要問我');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── Tools ─────────────────────────────────────────────────────────────────

describe('voice tools', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'qs-voice-tool-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function ctx(bridge: CodingSessionBridge, actions: string[] = []) {
    return { sessionId: 's1', cwd, bridge, emitAction: (s: string) => actions.push(s) };
  }

  it('send_to_coding_agent steers, with and without interrupt', async () => {
    const { bridge, calls } = makeBridge();
    const actions: string[] = [];
    await executeTool('send_to_coding_agent', { prompt: '用 TypeScript 改寫' }, ctx(bridge, actions));
    await executeTool('send_to_coding_agent', { prompt: '停，改做 X', interrupt: true }, ctx(bridge, actions));
    expect(calls.send).toEqual([
      { sessionId: 's1', prompt: '用 TypeScript 改寫', interrupt: false },
      { sessionId: 's1', prompt: '停，改做 X', interrupt: true },
    ]);
    expect(actions.length).toBe(2);
  });

  it('stop_coding_agent interrupts the turn', async () => {
    const { bridge, calls } = makeBridge();
    const out = await executeTool('stop_coding_agent', {}, ctx(bridge));
    expect(calls.interrupt).toBe(1);
    expect(out).toContain('stopped');
  });

  it('respond_to_permission only relays a matching pending request', async () => {
    const pending: ClaudeUserInputRequestPayload[] = [
      { sessionId: 's1', requestId: 'r1', inputType: 'permission', title: 'Bash', toolName: 'Bash' },
    ];
    const { bridge, calls } = makeBridge({ pending });
    // unknown id → no relay
    const miss = await executeTool('respond_to_permission', { request_id: 'nope', decision: 'allow' }, ctx(bridge));
    expect(miss).toContain('no pending');
    expect(calls.resolve.length).toBe(0);
    // matching id → relays the user's decision
    const hit = await executeTool('respond_to_permission', { request_id: 'r1', decision: 'allow' }, ctx(bridge));
    expect(hit).toContain('allow');
    expect(calls.resolve).toEqual([{ sessionId: 's1', requestId: 'r1', action: 'allow', response: undefined }]);
  });

  it('set_permission_mode forwards to the bridge', async () => {
    const { bridge, calls } = makeBridge();
    await executeTool('set_permission_mode', { mode: 'plan' }, ctx(bridge));
    expect(calls.setPerm).toEqual([{ sessionId: 's1', level: 'plan' }]);
  });

  it('get_status summarizes streaming + pending permission', async () => {
    const pending: ClaudeUserInputRequestPayload[] = [
      { sessionId: 's1', requestId: 'r9', inputType: 'permission', title: 'Bash', toolName: 'Bash', toolInput: { command: 'git push' } },
    ];
    const { bridge } = makeBridge({ pending, perm: 'default', streaming: true });
    const out = JSON.parse(await executeTool('get_status', {}, ctx(bridge)));
    expect(out.running).toBe(true);
    expect(out.permission_mode).toBe('default');
    expect(out.pending_permissions[0]).toMatchObject({ request_id: 'r9', tool: 'Bash' });
  });

  it('read_cards formats and filters by query', async () => {
    const cards: Card[] = [
      { id: 's1:1', timestamp: 1, type: 'user', text: '跑測試' } as Card,
      { id: 's1:2', timestamp: 2, type: 'tool_call', toolName: 'Bash', toolInput: { command: 'pnpm test' }, toolUseId: 't1', result: { content: '2 failed', isError: true, truncated: false } } as Card,
    ];
    const { bridge } = makeBridge({ cards });
    const all = await executeTool('read_cards', {}, ctx(bridge));
    expect(all).toContain('[你] 跑測試');
    expect(all).toContain('[工具] Bash');
    const filtered = await executeTool('read_cards', { query: 'failed' }, ctx(bridge));
    expect(filtered).toContain('2 failed');
    expect(filtered).not.toContain('[你] 跑測試');
  });

  it('remember persists to the workspace memory file', async () => {
    const { bridge } = makeBridge();
    await executeTool('remember', { note: '測試=pnpm test', section: 'fact' }, ctx(bridge));
    const raw = await readFile(workspaceMemoryPath(cwd), 'utf8');
    expect(raw).toContain('測試=pnpm test');
  });

  it('formatCardForBrain renders each card kind compactly', () => {
    expect(formatCardForBrain({ id: 'a', timestamp: 0, type: 'assistant_text', text: 'hi' } as Card)).toContain('[Claude]');
    expect(formatCardForBrain({ id: 'b', timestamp: 0, type: 'system', text: 'boom', subtype: 'error' } as Card)).toContain('[系統/error]');
  });
});

// ── Session loop ────────────────────────────────────────────────────────────

describe('VoiceIntermediarySession', () => {
  it('runs a tool then speaks the final answer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-sess-'));
    try {
      const { bridge } = makeBridge({ cwd, streaming: true });
      const events: VoiceAgentEvent[] = [];
      const session = new VoiceIntermediarySession({
        sessionId: 's1',
        cwd,
        config: CONFIG,
        bridge,
        callbacks: { emit: (e) => events.push(e), storeAudio: () => 'audio-xyz' },
        fetchImpl: scriptedFetch([
          { tool: { name: 'get_status' } }, // round 1: silent tool call
          { content: '它在跑測試，兩個掛了。' }, // round 2: final spoken answer
        ]),
      });
      await session.handleUtterance('它在幹嘛?');

      const speak = events.find((e) => e.kind === 'speak');
      expect(speak).toBeDefined();
      expect(speak).toMatchObject({ kind: 'speak', text: '它在跑測試，兩個掛了。', audioId: 'audio-xyz' });
      expect(events.some((e) => e.kind === 'state' && e.state === 'thinking')).toBe(true);
      expect(events.at(-1)).toMatchObject({ kind: 'state', state: 'idle' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('emits a text-only speak when no TTS model is configured', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-sess2-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const events: VoiceAgentEvent[] = [];
      const session = new VoiceIntermediarySession({
        sessionId: 's1',
        cwd,
        config: { ...CONFIG, ttsModel: undefined },
        bridge,
        callbacks: { emit: (e) => events.push(e), storeAudio: () => 'should-not-be-called' },
        fetchImpl: scriptedFetch([{ content: '好的。' }]),
      });
      await session.handleUtterance('嗨');
      const speak = events.find((e) => e.kind === 'speak');
      expect(speak).toMatchObject({ kind: 'speak', text: '好的。', audioId: '' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── Manager ─────────────────────────────────────────────────────────────────

describe('VoiceIntermediaryManager', () => {
  it('attach reports active only when live + brain configured', () => {
    const { bridge } = makeBridge({ cwd: '/tmp/x', open: true });
    const mgr = new VoiceIntermediaryManager(bridge);
    expect(mgr.attach('s1', CONFIG)).toEqual({ ok: true, active: true });
    expect(mgr.attach('s1', { ...CONFIG, agentModel: undefined }).active).toBe(false);

    const { bridge: closed } = makeBridge({ cwd: '/tmp/x', open: false });
    const mgr2 = new VoiceIntermediaryManager(closed);
    expect(mgr2.attach('s1', CONFIG)).toEqual({ ok: true, active: false });
    expect(mgr2.isAttached('s1')).toBe(false);
  });

  it('routes an utterance through the brain and caches audio for fetch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-mgr-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const mgr = new VoiceIntermediaryManager(bridge, scriptedFetch([{ content: '收到。' }]));
      const events: { sessionId: string; event: VoiceAgentEvent }[] = [];
      mgr.on('event', (sessionId: string, event: VoiceAgentEvent) => events.push({ sessionId, event }));

      mgr.attach('s1', CONFIG);
      await mgr.handleUtterance('s1', '嗨');

      const speak = events.map((e) => e.event).find((e) => e.kind === 'speak');
      expect(speak).toMatchObject({ kind: 'speak', text: '收到。' });
      const audioId = (speak as { audioId: string }).audioId;
      const audio = mgr.getAudio(audioId);
      expect(audio).not.toBeNull();
      expect(audio!.mimeType).toBe('audio/mpeg');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('emits a friendly error when an utterance arrives before attach', async () => {
    const { bridge } = makeBridge();
    const mgr = new VoiceIntermediaryManager(bridge);
    const events: VoiceAgentEvent[] = [];
    mgr.on('event', (_s: string, e: VoiceAgentEvent) => events.push(e));
    await mgr.handleUtterance('s1', '嗨');
    expect(events[0]).toMatchObject({ kind: 'error' });
  });

  it('notifyPendingPermission wakes the agent to narrate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-perm-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const mgr = new VoiceIntermediaryManager(bridge, scriptedFetch([{ content: '它要 push，要讓它做嗎？' }]));
      const events: VoiceAgentEvent[] = [];
      mgr.on('event', (_s: string, e: VoiceAgentEvent) => events.push(e));
      mgr.attach('s1', CONFIG);
      mgr.notifyPendingPermission({ sessionId: 's1', requestId: 'r1', inputType: 'permission', title: 'Bash', toolName: 'Bash', toolInput: { command: 'git push' } });
      // let the async turn settle
      await new Promise((r) => setTimeout(r, 20));
      expect(events.some((e) => e.kind === 'speak')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
