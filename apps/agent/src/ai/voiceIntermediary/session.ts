// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * One voice-intermediary conversation bound to a single coding session. Holds
 * the brain's message history in RAM (no persistent store — the coding agent's
 * cards ARE the memory; this re-derives via read_cards), and runs a tool-calling
 * loop per user utterance: narrate → maybe call silent tools → speak the result.
 */
import type { VoiceAgentEvent, VoiceConfig } from '@sumicom/quicksave-shared';
import { chatCompletion, type ChatMessage, type FetchLike } from './llm.js';
import { synthesizeSpeech } from './tts.js';
import { VOICE_AGENT_TOOLS, executeTool, type CodingSessionBridge } from './tools.js';
import { loadMemory } from './memory.js';

/** Upper bound on tool round-trips per utterance — a runaway-loop backstop. */
const MAX_TOOL_TURNS = 6;

export interface VoiceSessionCallbacks {
  emit: (event: VoiceAgentEvent) => void;
  /** Persist audio bytes and return an id the PWA fetches on demand. */
  storeAudio: (audio: Buffer, mimeType: string) => string;
}

export interface VoiceSessionOpts {
  sessionId: string;
  cwd: string;
  config: VoiceConfig;
  bridge: CodingSessionBridge;
  callbacks: VoiceSessionCallbacks;
  /** Injected for tests. */
  fetchImpl?: FetchLike;
}

export class VoiceIntermediarySession {
  readonly sessionId: string;
  private cwd: string;
  private config: VoiceConfig;
  private readonly bridge: CodingSessionBridge;
  private readonly cb: VoiceSessionCallbacks;
  private readonly fetchImpl?: FetchLike;

  private messages: ChatMessage[] = [];
  private ready: Promise<void>;
  /** Serializes turns so overlapping utterances don't interleave tool calls. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: VoiceSessionOpts) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.config = opts.config;
    this.bridge = opts.bridge;
    this.cb = opts.callbacks;
    this.fetchImpl = opts.fetchImpl;
    this.ready = this.init();
  }

  /** Refresh config (e.g. user changed model/voice) without losing history. */
  updateConfig(config: VoiceConfig, cwd?: string): void {
    this.config = config;
    if (cwd) this.cwd = cwd;
  }

  /** True when a brain model is configured, i.e. the agent can actually respond. */
  hasBrain(): boolean {
    return !!this.config.agentModel?.trim();
  }

  private async init(): Promise<void> {
    const memory = await loadMemory(this.cwd).catch(() => '');
    this.messages = [{ role: 'system', content: buildSystemPrompt(memory) }];
  }

  /** Handle a final user utterance (STT transcript). Serialized per session. */
  handleUtterance(text: string): Promise<void> {
    const run = this.chain.then(() => this.runTurn({ role: 'user', content: text }));
    // Swallow errors on the chain so one failed turn doesn't poison the next.
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Proactively wake the agent on a coding-side event (e.g. permission pending). */
  notify(systemNote: string): Promise<void> {
    const run = this.chain.then(() => this.runTurn({ role: 'user', content: `（系統事件）${systemNote}` }));
    this.chain = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.closed = true;
  }

  private async runTurn(userMessage: ChatMessage): Promise<void> {
    await this.ready;
    if (this.closed) return;
    this.messages.push(userMessage);

    this.cb.emit({ kind: 'state', state: 'thinking' });
    try {
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const result = await chatCompletion(this.config, {
          messages: this.messages,
          tools: VOICE_AGENT_TOOLS,
          fetchImpl: this.fetchImpl,
        });
        if (this.closed) return;

        // Speak any narration the model produced this round (interim or final).
        if (result.content) await this.speak(result.content);

        this.messages.push({
          role: 'assistant',
          content: result.content || null,
          ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
        });

        if (result.toolCalls.length === 0) break;

        for (const call of result.toolCalls) {
          const args = safeParseArgs(call.function.arguments);
          const toolResult = await executeTool(call.function.name, args, {
            sessionId: this.sessionId,
            cwd: this.cwd,
            bridge: this.bridge,
            emitAction: (summary) => this.cb.emit({ kind: 'action', summary }),
          });
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
        }
      }
    } catch (err) {
      this.cb.emit({ kind: 'error', message: (err as Error).message });
    } finally {
      if (!this.closed) this.cb.emit({ kind: 'state', state: 'idle' });
    }
  }

  private async speak(text: string): Promise<void> {
    this.cb.emit({ kind: 'state', state: 'speaking' });
    try {
      const speech = await synthesizeSpeech(this.config, text, { fetchImpl: this.fetchImpl });
      if (this.closed) return;
      if (speech) {
        const audioId = this.cb.storeAudio(speech.audio, speech.mimeType);
        this.cb.emit({ kind: 'speak', audioId, text, mimeType: speech.mimeType });
      } else {
        // No TTS configured — still surface the text so the PWA can render/voice it.
        this.cb.emit({ kind: 'speak', audioId: '', text, mimeType: '' });
      }
    } catch (err) {
      // A TTS failure shouldn't kill the turn — show the text, report the error.
      this.cb.emit({ kind: 'speak', audioId: '', text, mimeType: '' });
      this.cb.emit({ kind: 'error', message: (err as Error).message });
    }
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function buildSystemPrompt(memory: string): string {
  return [
    '你是使用者的「AI 同事」，一個語音中介。你站在使用者與一個 coding agent（例如 Claude Code）之間，用「講話」幫使用者掌握與操控它。',
    '',
    '語言與風格：',
    '- 一律用繁體中文（台灣用語）、口語、簡短地回覆；你的回覆文字會被唸出來給使用者聽。',
    '- 漸進式揭露：先講重點（一到兩句標題），需要細節時使用者會自己問。絕不把長輸出逐字唸出來。',
    '- 查詢類動作（讀卡片、查狀態）保持安靜，只有真正要告訴使用者的結論才開口。',
    '',
    '你能做的事（工具）：',
    '- send_to_coding_agent：把使用者的意思轉成 prompt 引導 coding agent；stop_coding_agent：喊停。',
    '- get_status / read_cards：掌握現況、詮釋它做了什麼。',
    '- respond_to_permission：回覆權限提示；set_permission_mode：調整自主度。',
    '- remember：記住長期偏好／界線／專案常識。',
    '',
    '信任界線（重要）：',
    '- 引導（送 prompt）是可逆的，放手做。',
    '- 不可逆的動作——回覆權限提示、放寬自主度——你「不自己決定」。先用講的說明它要做什麼並詢問使用者，取得明確的口頭同意後，才呼叫 respond_to_permission／set_permission_mode 把使用者的決定送出去。',
    '- push、刪除、部署、對外送出這類，務必先取得清楚的口頭「好」。',
    '',
    '記憶：使用者講到「以後都…」「這專案不准…」「測試指令是…」這類長期規則時，用 remember 記下來。',
    '',
    memory
      ? `以下是你已經記住的事，請遵守：\n\n${memory}`
      : '（你目前還沒有記住任何事。）',
  ].join('\n');
}
