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
import { executeTool, formatCardForBrain, VOICE_AGENT_TOOLS, type CodingSessionBridge } from './tools.js';
import { buildRuntimeContextReminder, buildSystemPrompt, sanitizeMessagesForResponses, VoiceIntermediarySession } from './session.js';
import { VoiceIntermediaryManager, type VoiceManagerBridge } from './manager.js';
import { responseCompletion } from './llm.js';
import { streamPcmSpeech, synthesizeSpeech } from './tts.js';
import { VoiceHistoryStore } from './historyStore.js';
import { setQuicksaveDir } from '../../service/singleton.js';

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
  ttsInstructions: '自然、溫和、語速稍快。',
};

let quicksaveDir: string;

beforeEach(async () => {
  quicksaveDir = await mkdtemp(join(tmpdir(), 'qs-voice-state-'));
  setQuicksaveDir(quicksaveDir);
});

afterEach(async () => {
  await rm(quicksaveDir, { recursive: true, force: true });
});

function responsesPayload(
  content = '',
  tool?: { name: string; args?: unknown },
  index = 1,
): string {
  const output: Array<Record<string, unknown>> = [];
  if (content) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    });
  }
  if (tool) {
    output.push({
      type: 'function_call',
      id: `fc-${index}`,
      call_id: `call-${index}`,
      name: tool.name,
      arguments: JSON.stringify(tool.args ?? {}),
    });
  }
  return JSON.stringify({ id: `resp-${index}`, status: 'completed', output });
}

/** A scripted OpenAI-compatible endpoint: N brain turns then audio. */
function scriptedFetch(chatTurns: { content?: string; tool?: { name: string; args?: unknown } }[]): typeof fetch {
  let i = 0;
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/responses')) {
      const turn = chatTurns[Math.min(i, chatTurns.length - 1)];
      i++;
      return new Response(responsesPayload(turn.content, turn.tool, i), { status: 200 });
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

// ── Chat message normalization ─────────────────────────────────────────────

describe('voice chat message normalization', () => {
  it('drops orphan tool messages before calling Responses', () => {
    const messages = sanitizeMessagesForResponses([
      { role: 'system', content: 's' },
      { role: 'tool', tool_call_id: 'missing', content: 'orphan' },
      { role: 'user', content: 'hi' },
    ]);

    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('keeps complete assistant tool-call groups', () => {
    const messages = sanitizeMessagesForResponses([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_status', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'running' },
      { role: 'user', content: 'status?' },
    ]);

    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(messages[0]?.tool_calls?.[0]?.id).toBe('call-1');
  });

  it('removes dangling assistant tool_calls when the result is missing', () => {
    const messages = sanitizeMessagesForResponses([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_status', arguments: '{}' } }],
      },
      { role: 'user', content: 'next' },
    ]);

    expect(messages.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(messages[0]?.tool_calls).toBeUndefined();
    expect(messages[0]?.content).toContain('工具結果不完整');
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
    expect(actions).toEqual([
      expect.stringContaining('開始處理'),
      expect.stringContaining('改做'),
    ]);
    expect(actions.join('\n')).not.toContain('coding agent');
  });

  it('investigate_with_coding_agent dispatches read-only work directly', async () => {
    const { bridge, calls } = makeBridge();
    const actions: string[] = [];
    const out = await executeTool(
      'investigate_with_coding_agent',
      { prompt: '只讀取檢查 TTS log，不要修改檔案' },
      ctx(bridge, actions),
    );
    expect(out).toBe('investigation dispatched');
    expect(calls.send).toEqual([
      { sessionId: 's1', prompt: '只讀取檢查 TTS log，不要修改檔案', interrupt: false },
    ]);
    expect(actions).toEqual([expect.stringContaining('開始查')]);
  });

  it('coding change proposal callbacks require explicit confirmation', async () => {
    const { bridge } = makeBridge();
    const actions: string[] = [];
    let pending: { id: string; prompt: string; spokenSummary: string } | null = null;
    const base = ctx(bridge, actions);
    const proposed = await executeTool('propose_coding_change', {
      prompt: '修改首頁高度並跑測試',
      spoken_summary: '修改首頁高度並跑相關測試',
    }, {
      ...base,
      proposeCodingChange: (proposal) => {
        pending = { id: 'p1', prompt: proposal.prompt, spokenSummary: proposal.spokenSummary };
        return 'p1';
      },
    });
    expect(proposed).toContain('"pending_proposal_id":"p1"');
    expect(actions).toEqual([expect.stringContaining('等待確認')]);

    const confirmed = await executeTool('confirm_coding_change', {}, {
      ...base,
      confirmCodingChange: () => {
        if (!pending) return 'error: no pending proposal';
        return `sent ${pending.id}`;
      },
    });
    expect(confirmed).toBe('sent p1');
  });

  it('stop_coding_agent interrupts the turn', async () => {
    const { bridge, calls } = makeBridge();
    const out = await executeTool('stop_coding_agent', {}, ctx(bridge));
    expect(calls.interrupt).toBe(1);
    expect(out).toContain('stopped');
  });

  it('stop_coding_agent action is phrased as stopping current work', async () => {
    const { bridge } = makeBridge();
    const actions: string[] = [];
    const out = await executeTool('stop_coding_agent', {}, ctx(bridge, actions));
    expect(out).toContain('stopped');
    expect(actions).toEqual(['已停止目前工作']);
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

  it('read_cards includes passive live context observed by the voice session', async () => {
    const { bridge } = makeBridge({ cards: [] });
    const out = await executeTool('read_cards', { query: '最新' }, {
      ...ctx(bridge),
      liveContext: '[Claude] 最新 streaming 輸出',
    });
    expect(out).toContain('最新 streaming 輸出');
  });

  it('remember persists to the workspace memory file', async () => {
    const { bridge } = makeBridge();
    await executeTool('remember', { note: '測試=pnpm test', section: 'fact' }, ctx(bridge));
    const raw = await readFile(workspaceMemoryPath(cwd), 'utf8');
    expect(raw).toContain('測試=pnpm test');
  });

  it('read_voice_history searches the voice agent JSONL history', async () => {
    const { bridge } = makeBridge();
    const store = new VoiceHistoryStore('s1');
    await store.appendChatMessage({ role: 'user', content: '我剛剛說要保留 context window' });
    const out = await executeTool('read_voice_history', { query: 'context', limit: 5 }, {
      ...ctx(bridge),
      readVoiceHistory: (opts) => store.read(opts),
    });
    expect(out).toContain('保留 context window');
  });

  it('formatCardForBrain renders each card kind compactly', () => {
    expect(formatCardForBrain({ id: 'a', timestamp: 0, type: 'assistant_text', text: 'hi' } as Card)).toContain('[Claude]');
    expect(formatCardForBrain({ id: 'b', timestamp: 0, type: 'system', text: 'boom', subtype: 'error' } as Card)).toContain('[系統/error]');
  });
});

// ── Session loop ────────────────────────────────────────────────────────────

describe('voice system prompt', () => {
  it('presents the voice agent as the user-facing owner, not a third-party narrator', () => {
    const prompt = buildSystemPrompt('');
    expect(prompt).toContain('你就是正在協助他的 agent');
    expect(prompt).toContain('內部工具與 coding agent 是你的執行能力');
    expect(prompt).toContain('不要說「我去叫 coding agent」');
    expect(prompt).toContain('我來處理');
    expect(prompt).toContain('預設只講 1 到 3 句');
    expect(prompt).toContain('絕不把長輸出');
    expect(prompt).toContain('不要唸檔名、hash、路徑');
    expect(prompt).toContain('grounding 規則');
    expect(prompt).toContain('事實性、回顧性、狀態性、原因判斷、承接前文的回答必須有依據');
    expect(prompt).toContain('先安靜使用 read_voice_history');
    expect(prompt).toContain('用 read_cards');
    expect(prompt).toContain('用 get_status');
    expect(prompt).toContain('我目前沒有看到足夠紀錄');
    expect(prompt).toContain('coding 指令 dispatch 規則');
    expect(prompt).toContain('read-only 調查');
    expect(prompt).toContain('propose_coding_change');
    expect(prompt).toContain('confirm_coding_change');
    expect(prompt).toContain('直接送進語音合成的口語講稿');
    expect(prompt).toContain('禁止標題、條列、編號、表格、Markdown');
    expect(prompt).toContain('不限制內部 tool arguments');
  });

  it('warns each model request not to imitate stale voice history formatting', () => {
    const reminder = buildRuntimeContextReminder();
    expect(reminder).toContain('不是目前 coding 進度的權威來源');
    expect(reminder).toContain('禁止模仿其格式');
    expect(reminder).toContain('可直接朗讀的純口語');
  });

  it('requires user-facing tool summaries to be plain spoken text', () => {
    const descriptions = Object.fromEntries(VOICE_AGENT_TOOLS.map((tool) => [
      tool.function.name,
      `${tool.function.description ?? ''} ${JSON.stringify(tool.function.parameters)}`,
    ]));
    expect(descriptions.propose_coding_change).toContain('no Markdown');
    expect(descriptions.get_status).toContain('plain spoken');
    expect(descriptions.read_cards).toContain('Never preserve or quote that layout');
    expect(descriptions.read_voice_history).toContain('never imitate it');
  });
});

describe('voice LLM client', () => {
  it('uses the Responses request shape without sampling overrides', async () => {
    let body: Record<string, unknown> | undefined;
    let url = '';
    const fetchImpl = (async (requestUrl: string | URL | Request, init?: RequestInit) => {
      url = String(requestUrl);
      body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(responsesPayload('ok'), { status: 200 });
    }) as typeof fetch;

    const result = await responseCompletion(CONFIG, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: { name: 'get_status', description: 'status', parameters: { type: 'object' } },
      }],
      fetchImpl,
    });

    expect(url).toBe(`${CONFIG.baseUrl}/responses`);
    expect(body).toMatchObject({
      model: CONFIG.agentModel,
      input: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', name: 'get_status', description: 'status' }],
      tool_choice: 'auto',
      store: false,
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(result).toEqual({
      content: 'ok',
      toolCalls: [],
      reasoningItems: [],
      reasoningSummary: [],
    });
  });

  it('sends configured reasoning effort and replays durable reasoning items', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({
        output: [
          {
            type: 'reasoning',
            id: 'rs-new',
            status: 'completed',
            summary: [{ type: 'summary_text', text: 'Checked the latest evidence.' }],
            encrypted_content: 'encrypted-new',
            content: [{ type: 'reasoning_text', text: 'must not persist plaintext reasoning' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
          },
        ],
      }), { status: 200 });
    }) as typeof fetch;

    const result = await responseCompletion({ ...CONFIG, agentReasoningEffort: 'medium' }, {
      messages: [
        { role: 'assistant', content: null, reasoning_items: [{
          type: 'reasoning',
          id: 'rs-old',
          status: 'completed',
          summary: [{ type: 'summary_text', text: 'Earlier summary.' }],
          encrypted_content: 'encrypted-old',
        }], tool_calls: [{
          id: 'call-old',
          type: 'function',
          function: { name: 'get_status', arguments: '{}' },
        }] },
        { role: 'tool', tool_call_id: 'call-old', content: 'ready' },
      ],
      tools: [],
      fetchImpl,
    });

    expect(body).toMatchObject({
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      input: [
        expect.objectContaining({ type: 'reasoning', id: 'rs-old', encrypted_content: 'encrypted-old' }),
        { type: 'function_call', call_id: 'call-old', name: 'get_status', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-old', output: 'ready' },
      ],
    });
    expect(result.reasoningSummary).toEqual(['Checked the latest evidence.']);
    expect(result.reasoningItems).toEqual([{
      type: 'reasoning',
      id: 'rs-new',
      status: 'completed',
      summary: [{ type: 'summary_text', text: 'Checked the latest evidence.' }],
      encrypted_content: 'encrypted-new',
    }]);
    expect(result.reasoningItems[0]).not.toHaveProperty('content');
  });

  it('converts stored tool history and parses Responses function calls', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(responsesPayload('', { name: 'get_status', args: { detail: true } }), { status: 200 });
    }) as typeof fetch;

    const result = await responseCompletion(CONFIG, {
      messages: [
        { role: 'assistant', content: null, tool_calls: [{
          id: 'call-old',
          type: 'function',
          function: { name: 'read_cards', arguments: '{"limit":1}' },
        }] },
        { role: 'tool', tool_call_id: 'call-old', content: 'one card' },
        { role: 'user', content: 'what now?' },
      ],
      tools: [],
      fetchImpl,
    });

    expect(body?.input).toEqual([
      { type: 'function_call', call_id: 'call-old', name: 'read_cards', arguments: '{"limit":1}' },
      { type: 'function_call_output', call_id: 'call-old', output: 'one card' },
      { role: 'user', content: 'what now?' },
    ]);
    expect(result.toolCalls).toEqual([{
      id: 'call-1',
      type: 'function',
      function: { name: 'get_status', arguments: '{"detail":true}' },
    }]);
  });
});

describe('voice TTS client', () => {
  it('posts the OpenAI speech request shape and carries request metadata', async () => {
    let body: Record<string, unknown> | undefined;
    let headers: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'));
      headers = init?.headers as Record<string, string>;
      return new Response(Buffer.from([1, 2]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'x-request-id': 'req-123' },
      });
    }) as typeof fetch;

    const speech = await synthesizeSpeech(CONFIG, '測試語音', { fetchImpl });

    expect(body).toEqual({
      model: CONFIG.ttsModel,
      voice: CONFIG.ttsVoice,
      input: '測試語音',
      response_format: 'mp3',
      instructions: CONFIG.ttsInstructions,
    });
    expect(headers?.['Content-Type']).toBe('application/json');
    expect(headers?.['X-Client-Request-Id']).toMatch(/^quicksave-tts-/);
    expect(speech).toMatchObject({ mimeType: 'audio/mpeg', requestId: 'req-123' });
    expect(speech?.audio).toEqual(Buffer.from([1, 2]));
  });

  it('requests raw PCM and forwards response chunks without retaining the clip', async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(Buffer.from([1, 2, 3, 4]), {
        status: 200,
        headers: { 'x-request-id': 'req-pcm' },
      });
    }) as typeof fetch;
    const chunks: Buffer[] = [];

    const speech = await streamPcmSpeech(CONFIG, '串流測試', (chunk) => chunks.push(Buffer.from(chunk)), { fetchImpl });

    expect(body?.response_format).toBe('pcm');
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(speech).toMatchObject({ streamed: true, requestId: 'req-pcm' });
    expect(speech?.audio).toHaveLength(0);
  });
});

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

      const speechTextIndex = events.findIndex((e) => e.kind === 'speech-text');
      const speakIndex = events.findIndex((e) => e.kind === 'speak');
      expect(speechTextIndex).toBeGreaterThanOrEqual(0);
      expect(speechTextIndex).toBeLessThan(speakIndex);
      expect(events[speechTextIndex]).toEqual({ kind: 'speech-text', text: '它在跑測試，兩個掛了。' });
      const speak = events.find((e) => e.kind === 'speak');
      expect(speak).toBeDefined();
      expect(speak).toMatchObject({ kind: 'speak', text: '它在跑測試，兩個掛了。', audioId: 'audio-xyz' });
      expect(events.some((e) => e.kind === 'state' && e.state === 'thinking')).toBe(true);
      expect(events.at(-1)).toMatchObject({ kind: 'state', state: 'idle' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('dispatches tool calls before speaking model content from the same response', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-tool-before-speech-'));
    try {
      const { bridge: rawBridge, calls } = makeBridge({ cwd });
      const order: string[] = [];
      const bridge: VoiceManagerBridge = {
        ...rawBridge,
        sendUserMessageToSession: (sessionId, prompt, opts) => {
          order.push('send');
          return rawBridge.sendUserMessageToSession(sessionId, prompt, opts);
        },
      };
      const session = new VoiceIntermediarySession({
        sessionId: 's1',
        cwd,
        config: CONFIG,
        bridge,
        callbacks: {
          emit: (e) => {
            if (e.kind === 'speech-text') order.push(`speech:${e.text}`);
          },
          storeAudio: () => 'audio-order',
        },
        fetchImpl: scriptedFetch([
          {
            content: '我先幫你查。',
            tool: { name: 'investigate_with_coding_agent', args: { prompt: '只讀取檢查目前錯誤，不要修改檔案' } },
          },
          { content: '好，我正在查目前錯誤。' },
        ]),
      });

      await session.handleUtterance('幫我查錯誤');

      expect(calls.send).toEqual([
        { sessionId: 's1', prompt: '只讀取檢查目前錯誤，不要修改檔案', interrupt: false },
      ]);
      expect(order[0]).toBe('send');
      expect(order).not.toContain('speech:我先幫你查。');
      expect(order).toContain('speech:好，我正在查目前錯誤。');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('requires confirmation before sending a proposed coding change', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-proposal-'));
    try {
      const { bridge, calls } = makeBridge({ cwd });
      const events: VoiceAgentEvent[] = [];
      const session = new VoiceIntermediarySession({
        sessionId: 's1',
        cwd,
        config: CONFIG,
        bridge,
        callbacks: { emit: (e) => events.push(e), storeAudio: () => 'audio-proposal' },
        fetchImpl: scriptedFetch([
          {
            tool: {
              name: 'propose_coding_change',
              args: {
                prompt: '修改首頁高度並跑相關測試',
                spoken_summary: '修改首頁高度並跑相關測試',
              },
            },
          },
          { content: '確認一下：我要送出修改首頁高度並跑相關測試。要執行嗎？' },
          { tool: { name: 'confirm_coding_change' } },
          { content: '好，已送出。' },
        ]),
      });

      await session.handleUtterance('幫我修首頁高度');
      expect(calls.send).toHaveLength(0);
      expect(events.some((e) => e.kind === 'speech-text' && e.text.includes('確認一下'))).toBe(true);

      await session.handleUtterance('好');
      expect(calls.send).toEqual([
        { sessionId: 's1', prompt: '修改首頁高度並跑相關測試', interrupt: false },
      ]);
      expect(events.some((e) => e.kind === 'speech-text' && e.text === '好，已送出。')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('restores a pending coding-change proposal after the intermediary reloads', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-proposal-restore-'));
    try {
      const { bridge, calls } = makeBridge({ cwd });
      const sessionId = 's-proposal-restore';
      const first = new VoiceIntermediarySession({
        sessionId,
        cwd,
        config: CONFIG,
        bridge,
        callbacks: { emit: () => undefined, storeAudio: () => 'audio-proposal-1' },
        fetchImpl: scriptedFetch([
          {
            tool: {
              name: 'propose_coding_change',
              args: {
                prompt: '修改側邊欄並跑測試',
                spoken_summary: '修改側邊欄並跑測試',
              },
            },
          },
          { content: '要執行嗎？' },
        ]),
      });
      await first.handleUtterance('幫我改側邊欄');
      first.close();
      expect(calls.send).toHaveLength(0);

      const second = new VoiceIntermediarySession({
        sessionId,
        cwd,
        config: CONFIG,
        bridge,
        callbacks: { emit: () => undefined, storeAudio: () => 'audio-proposal-2' },
        fetchImpl: scriptedFetch([
          { tool: { name: 'confirm_coding_change' } },
          { content: '已送出。' },
        ]),
      });
      await second.handleUtterance('好');

      expect(calls.send).toEqual([
        { sessionId, prompt: '修改側邊欄並跑測試', interrupt: false },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('loads prior voice context on startup before sending the next LLM request', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-restore-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const sessionId = 's-restore';
      const first = new VoiceIntermediarySession({
        sessionId,
        cwd,
        config: CONFIG,
        bridge,
        callbacks: { emit: () => undefined, storeAudio: () => 'audio-1' },
        fetchImpl: scriptedFetch([{ content: '回答一。' }]),
      });
      await first.handleUtterance('第一句');
      first.close();

      const bodies: Array<{ input?: Array<{ role?: string; content?: string | null }> }> = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/responses')) {
          bodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response(responsesPayload('回答二。'), { status: 200 });
        }
        if (u.endsWith('/audio/speech')) return new Response(Buffer.from([1]), { status: 200 });
        throw new Error(`unexpected url ${u}`);
      }) as typeof fetch;

      const second = new VoiceIntermediarySession({
        sessionId,
        cwd,
        config: CONFIG,
        bridge,
        callbacks: { emit: () => undefined, storeAudio: () => 'audio-2' },
        fetchImpl,
      });
      await second.handleUtterance('第二句');

      const sent = bodies[0]?.input?.map((m) => m.content ?? '').join('\n') ?? '';
      expect(sent).toContain('第一句');
      expect(sent).toContain('回答一。');
      expect(sent).toContain('第二句');
      expect(sent).toContain('禁止模仿其格式');
      expect(sent.lastIndexOf('第二句')).toBeLessThan(sent.lastIndexOf('禁止模仿其格式'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('replays reasoning state across tool rounds and session reloads', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-reasoning-restore-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const sessionId = 's-reasoning-restore';
      const config = { ...CONFIG, agentReasoningEffort: 'medium' as const };
      const firstBodies: Array<{ input?: Array<Record<string, unknown>> }> = [];
      let firstRound = 0;
      const firstFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/responses')) {
          firstBodies.push(JSON.parse(String(init?.body ?? '{}')));
          firstRound++;
          if (firstRound === 1) {
            return new Response(JSON.stringify({ output: [
              {
                type: 'reasoning',
                id: 'rs-persisted',
                status: 'completed',
                summary: [{ type: 'summary_text', text: 'Need current status.' }],
                encrypted_content: 'encrypted-persisted',
              },
              { type: 'function_call', call_id: 'call-status', name: 'get_status', arguments: '{}' },
            ] }), { status: 200 });
          }
          return new Response(responsesPayload('狀態正常。'), { status: 200 });
        }
        if (u.endsWith('/audio/speech')) return new Response(Buffer.from([1]), { status: 200 });
        throw new Error(`unexpected url ${u}`);
      }) as typeof fetch;
      const first = new VoiceIntermediarySession({
        sessionId,
        cwd,
        config,
        bridge,
        callbacks: { emit: () => undefined, storeAudio: () => 'audio-reasoning-1' },
        fetchImpl: firstFetch,
      });
      await first.handleUtterance('現在狀態？');
      first.close();

      expect(firstBodies[1]?.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', id: 'rs-persisted', encrypted_content: 'encrypted-persisted' }),
      ]));

      const secondBodies: Array<{ input?: Array<Record<string, unknown>> }> = [];
      const secondFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/responses')) {
          secondBodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response(responsesPayload('仍然正常。'), { status: 200 });
        }
        if (u.endsWith('/audio/speech')) return new Response(Buffer.from([1]), { status: 200 });
        throw new Error(`unexpected url ${u}`);
      }) as typeof fetch;
      const second = new VoiceIntermediarySession({
        sessionId,
        cwd,
        config,
        bridge,
        callbacks: { emit: () => undefined, storeAudio: () => 'audio-reasoning-2' },
        fetchImpl: secondFetch,
      });
      await second.handleUtterance('再確認一次');

      expect(secondBodies[0]?.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', id: 'rs-persisted', encrypted_content: 'encrypted-persisted' }),
      ]));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not send restored orphan tool messages to Responses', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-orphan-tool-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const sessionId = 's-orphan-tool';
      const history = new VoiceHistoryStore(sessionId);
      await history.appendChatMessage({ role: 'tool', tool_call_id: 'missing-call', content: 'old orphan result' });
      await history.appendChatMessage({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'dangling-call', type: 'function', function: { name: 'get_status', arguments: '{}' } }],
      });

      const bodies: Array<{ input?: Array<{ type?: string; role?: string }> }> = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/responses')) {
          bodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response(responsesPayload('收到。'), { status: 200 });
        }
        if (u.endsWith('/audio/speech')) return new Response(Buffer.from([1]), { status: 200 });
        throw new Error(`unexpected url ${u}`);
      }) as typeof fetch;

      const session = new VoiceIntermediarySession({
        sessionId,
        cwd,
        config: CONFIG,
        bridge,
        callbacks: { emit: () => undefined, storeAudio: () => 'audio-orphan' },
        fetchImpl,
      });
      await session.handleUtterance('繼續');

      const input = bodies[0]?.input ?? [];
      expect(input.some((item) => item.type === 'function_call_output')).toBe(false);
      expect(input.some((item) => item.type === 'function_call')).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('persists voice turn metadata in runtime history events', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-turn-meta-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const sessionId = 's-turn-meta';
      const session = new VoiceIntermediarySession({
        sessionId,
        cwd,
        config: CONFIG,
        bridge,
        callbacks: { emit: () => undefined, storeAudio: () => 'audio-meta' },
        fetchImpl: scriptedFetch([{ content: '收到。' }]),
      });

      await session.handleUtterance('嗨', {
        turnId: 'turn-1',
        interactionId: 'interaction-1',
        utteranceId: 'utterance-1',
      });

      const events = await new VoiceHistoryStore(sessionId).read({ includeRuntimeEvents: true, limit: 20 });
      const raw = events.map((e) => JSON.stringify(e)).join('\n');
      expect(raw).toContain('"event":"turn.start"');
      expect(raw).toContain('"turnId":"turn-1"');
      expect(raw).toContain('"interactionId":"interaction-1"');
      expect(raw).toContain('"utteranceId":"utterance-1"');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('tells the next LLM turn when the previous speech playback was interrupted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-playback-note-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const bodies: Array<{ input?: Array<{ role?: string; content?: string | null }> }> = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/responses')) {
          bodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response(responsesPayload('我接著處理。'), { status: 200 });
        }
        if (u.endsWith('/audio/speech')) return new Response(Buffer.from([1]), { status: 200 });
        throw new Error(`unexpected url ${u}`);
      }) as typeof fetch;
      const session = new VoiceIntermediarySession({
        sessionId: 's-playback-note',
        cwd,
        config: CONFIG,
        bridge,
        callbacks: { emit: () => undefined, storeAudio: () => 'audio-note' },
        fetchImpl,
      });

      session.recordPlaybackEvent({
        sessionId: 's-playback-note',
        event: 'interrupted',
        audioId: 'audio-1',
        turnId: 'turn-old',
      });
      await session.handleUtterance('我剛剛插話', { turnId: 'turn-new' });

      const sent = bodies[0]?.input?.map((m) => m.content ?? '').join('\n') ?? '';
      expect(sent).toContain('上一段語音回覆在播放中被使用者打斷');
      expect(sent).toContain('我剛剛插話');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('adds passive live card updates to the next LLM request without waking itself', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-live-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const bodies: Array<{ input?: Array<{ role?: string; content?: string }> }> = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/responses')) {
          bodies.push(JSON.parse(String(init?.body ?? '{}')));
          return new Response(responsesPayload('我看到了最新輸出。'), { status: 200 });
        }
        if (u.endsWith('/audio/speech')) {
          return new Response(Buffer.from([1]), { status: 200 });
        }
        throw new Error(`unexpected url ${u}`);
      }) as typeof fetch;
      const events: VoiceAgentEvent[] = [];
      const session = new VoiceIntermediarySession({
        sessionId: 's1',
        cwd,
        config: CONFIG,
        bridge,
        callbacks: { emit: (e) => events.push(e), storeAudio: () => 'audio-live' },
        fetchImpl,
      });

      session.recordCardEvent({
        type: 'add',
        sessionId: 's1',
        card: { id: 'c1', timestamp: 1, type: 'assistant_text', text: '正在跑', streaming: true } as Card,
      });
      session.recordCardEvent({ type: 'append_text', sessionId: 's1', cardId: 'c1', text: '最新測試' });
      expect(events).toEqual([]);

      await session.handleUtterance('目前看到什麼?');
      const sent = bodies[0]?.input?.map((item) => item.content ?? '').join('\n') ?? '';
      expect(sent).toContain('最新 live card/stream 更新');
      expect(sent).toContain('正在跑最新測試');
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

  it('downgrades unsupported TTS endpoints to text-only without repeating the failing request', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-tts404-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const events: VoiceAgentEvent[] = [];
      let chatCalls = 0;
      let ttsCalls = 0;
      const fetchImpl = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith('/responses')) {
          chatCalls++;
          return new Response(
            responsesPayload(chatCalls === 1 ? '第一次。' : '第二次。'),
            { status: 200 },
          );
        }
        if (u.endsWith('/audio/speech')) {
          ttsCalls++;
          return new Response(
            JSON.stringify({ error: { message: 'Invalid URL (POST /v1/audio/speech)' } }),
            { status: 404 },
          );
        }
        throw new Error(`unexpected url ${u}`);
      }) as typeof fetch;
      const session = new VoiceIntermediarySession({
        sessionId: 's1',
        cwd,
        config: CONFIG,
        bridge,
        callbacks: { emit: (e) => events.push(e), storeAudio: () => 'should-not-be-called' },
        fetchImpl,
      });

      await session.handleUtterance('嗨');
      await session.handleUtterance('再說一次');

      expect(ttsCalls).toBe(1);
      expect(events.filter((e) => e.kind === 'error')).toHaveLength(0);
      expect(events.filter((e) => e.kind === 'action')).toHaveLength(1);
      expect(events.filter((e) => e.kind === 'speak')).toEqual([
        { kind: 'speak', audioId: '', text: '第一次。', mimeType: '' },
        { kind: 'speak', audioId: '', text: '第二次。', mimeType: '' },
      ]);
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

  it('can delegate synthesized audio storage to a stable supervisor', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-external-audio-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const stored: Array<{ audio: Buffer; mimeType: string }> = [];
      const mgr = new VoiceIntermediaryManager(
        bridge,
        scriptedFetch([{ content: '收到。' }]),
        (audio, mimeType) => {
          stored.push({ audio, mimeType });
          return 'supervisor-audio-1';
        },
      );
      const events: VoiceAgentEvent[] = [];
      mgr.on('event', (_sessionId: string, event: VoiceAgentEvent) => events.push(event));

      mgr.attach('s1', CONFIG);
      await mgr.handleUtterance('s1', '嗨');

      expect(events.find((event) => event.kind === 'speak')).toMatchObject({
        kind: 'speak',
        audioId: 'supervisor-audio-1',
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.mimeType).toBe('audio/mpeg');
      expect(mgr.getAudio('supervisor-audio-1')).toBeNull();
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

  it('notifyStreamEnd wakes the agent but allows an empty no-op response', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-stream-noop-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const mgr = new VoiceIntermediaryManager(bridge, scriptedFetch([{ content: '' }]));
      const events: VoiceAgentEvent[] = [];
      mgr.on('event', (_s: string, e: VoiceAgentEvent) => events.push(e));
      mgr.attach('s1', CONFIG);

      mgr.recordStreamEnd({ sessionId: 's1', success: true, interrupted: false });
      mgr.notifyStreamEnd({ sessionId: 's1', success: true, interrupted: false });
      await new Promise((r) => setTimeout(r, 20));

      expect(events.filter((e) => e.kind === 'speak')).toHaveLength(0);
      expect(events.at(-1)).toMatchObject({ kind: 'state', state: 'idle' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('notifyStreamEnd can proactively speak a useful completion summary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qs-voice-stream-summary-'));
    try {
      const { bridge } = makeBridge({ cwd });
      const mgr = new VoiceIntermediaryManager(bridge, scriptedFetch([{ content: '測試跑完了，兩個失敗。' }]));
      const events: VoiceAgentEvent[] = [];
      mgr.on('event', (_s: string, e: VoiceAgentEvent) => events.push(e));
      mgr.attach('s1', CONFIG);

      mgr.notifyStreamEnd({ sessionId: 's1', success: false, interrupted: false, error: '2 tests failed' });
      await new Promise((r) => setTimeout(r, 20));

      expect(events.some((e) => e.kind === 'speak')).toBe(true);
      expect(events.find((e) => e.kind === 'speech-text')).toMatchObject({
        kind: 'speech-text',
        text: '測試跑完了，兩個失敗。',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
