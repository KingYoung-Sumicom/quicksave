// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * One voice-intermediary conversation bound to a single coding session. Holds
 * the brain's active message window in RAM and mirrors model-visible messages
 * into append-only JSONL so a restarted voice agent can resume its own context.
 * Coding-agent cards remain a separate implementation transcript read through
 * tools. Each user utterance runs a tool-calling
 * loop per user utterance: narrate → maybe call silent tools → speak the result.
 */
import type {
  Card,
  CardEvent,
  CardStreamEnd,
  VoiceAgentPlaybackEventRequestPayload,
  VoiceAgentEvent,
  VoiceConfig,
} from '@sumicom/quicksave-shared';
import { chatCompletion, type ChatMessage, type FetchLike } from './llm.js';
import { synthesizeSpeech } from './tts.js';
import { VOICE_AGENT_TOOLS, executeTool, formatCardForBrain, type CodingSessionBridge } from './tools.js';
import { loadMemory } from './memory.js';
import { voiceEventLogger } from '../voiceLog.js';
import { VoiceHistoryStore } from './historyStore.js';

/** Upper bound on tool round-trips per utterance — a runaway-loop backstop. */
const MAX_TOOL_TURNS = 6;
const LIVE_CARD_CAP = 30;
const VOICE_HISTORY_MAX_MESSAGES = 80;
const VOICE_HISTORY_KEEP_MESSAGES = 40;
const VOICE_COMPACTION_SUMMARY_CHARS = 4000;

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
  /** Injected for tests. */
  historyStore?: VoiceHistoryStore;
}

export interface VoiceTurnMeta {
  turnId?: string;
  interactionId?: string;
  utteranceId?: string;
}

export class VoiceIntermediarySession {
  readonly sessionId: string;
  private cwd: string;
  private config: VoiceConfig;
  private readonly bridge: CodingSessionBridge;
  private readonly cb: VoiceSessionCallbacks;
  private readonly fetchImpl?: FetchLike;
  private readonly history: VoiceHistoryStore;

  private messages: ChatMessage[] = [];
  private systemPrompt = '';
  private ready: Promise<void>;
  /** Serializes turns so overlapping utterances don't interleave tool calls. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  /** Set after a provider clearly rejects the TTS endpoint; keep later turns text-only. */
  private ttsUnavailableReason = '';
  /** Passive mirror of the coding agent's newest live card stream. */
  private readonly liveCards = new Map<string, Card>();
  private readonly liveNotes: string[] = [];
  private pendingPlaybackNote = '';

  constructor(opts: VoiceSessionOpts) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.config = opts.config;
    this.bridge = opts.bridge;
    this.cb = opts.callbacks;
    this.fetchImpl = opts.fetchImpl;
    this.history = opts.historyStore ?? new VoiceHistoryStore(this.sessionId);
    this.ready = this.init();
  }

  /** Refresh config (e.g. user changed model/voice) without losing history. */
  updateConfig(config: VoiceConfig, cwd?: string): void {
    this.config = config;
    if (cwd) this.cwd = cwd;
    this.ttsUnavailableReason = '';
  }

  /** True when a brain model is configured, i.e. the agent can actually respond. */
  hasBrain(): boolean {
    return !!this.config.agentModel?.trim();
  }

  private async init(): Promise<void> {
    const [memory, restored] = await Promise.all([
      loadMemory(this.cwd).catch(() => ''),
      this.history.restore(),
    ]);
    this.systemPrompt = buildSystemPrompt(memory);
    this.messages = [{ role: 'system', content: this.systemPrompt }];
    if (restored.compactionSummary) {
      this.messages.push({ role: 'system', content: buildCompactionMessage(restored.compactionSummary) });
    }
    this.messages.push(...restored.activeMessages);
  }

  /** Handle a final user utterance (STT transcript). Serialized per session. */
  handleUtterance(text: string, meta: VoiceTurnMeta = {}): Promise<void> {
    const run = this.chain.then(() => this.runTurn({ role: 'user', content: text }, meta));
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

  /** Wake the voice brain when the coding agent finishes a turn. The brain may no-op. */
  notifyCodingTurnEnded(result: CardStreamEnd): Promise<void> {
    const state = result.interrupted
      ? '已中斷'
      : result.success === false
        ? '失敗'
        : '已完成';
    const details = [
      result.error ? `錯誤：${result.error}` : '',
      result.totalCostUsd != null ? `成本：${result.totalCostUsd}` : '',
    ].filter(Boolean).join('；');
    const run = this.chain.then(() => this.runTurn({
      role: 'user',
      content:
        `（系統事件）coding agent 這一回合${state}${details ? `。${details}` : ''}。` +
        '請檢查最新 live cards / read_cards。若有使用者正在等待的答案、完成結果、錯誤、阻塞或需要確認，請用一句話主動告知。' +
        '若沒有值得打擾使用者的新資訊，請 no-op：回覆空內容且不要呼叫任何工具。',
    }));
    this.chain = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.closed = true;
    void this.history.flush();
  }

  /** Passively record coding-agent card updates. Does not wake or interrupt the voice LLM. */
  recordCardEvent(event: CardEvent): void {
    if (event.sessionId !== this.sessionId) return;
    switch (event.type) {
      case 'add':
        this.liveCards.set(event.card.id, { ...event.card });
        break;
      case 'append_text': {
        const card = this.liveCards.get(event.cardId);
        if (card && 'text' in card) {
          this.liveCards.set(event.cardId, { ...card, text: `${card.text}${event.text}` } as Card);
        }
        break;
      }
      case 'update': {
        const card = this.liveCards.get(event.cardId);
        if (!card) break;
        const next = { ...card } as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(event.patch)) {
          if (value === null) delete next[key];
          else next[key] = value;
        }
        this.liveCards.set(event.cardId, next as unknown as Card);
        break;
      }
      case 'remove':
        this.liveCards.delete(event.cardId);
        break;
    }
    this.trimLiveCards();
  }

  /** Record turn completion metadata without triggering a voice response. */
  recordStreamEnd(result: CardStreamEnd): void {
    if (result.sessionId !== this.sessionId) return;
    this.liveNotes.push(`[狀態] coding agent turn ${result.interrupted ? '已中斷' : '已完成'}`);
    while (this.liveNotes.length > 5) this.liveNotes.shift();
  }

  recordPlaybackEvent(event: VoiceAgentPlaybackEventRequestPayload): void {
    if (event.sessionId !== this.sessionId) return;
    void this.history.appendRuntimeEvent(`playback.${event.event}`, {
      turnId: event.turnId,
      interactionId: event.interactionId,
      utteranceId: event.utteranceId,
      audioId: event.audioId,
      reason: event.reason,
    });
    if (event.event === 'interrupted') {
      this.pendingPlaybackNote =
        '上一段語音回覆在播放中被使用者打斷；不要假設使用者已完整聽完那段回答。' +
        '下一次回覆時，先接住使用者新的話，不要重複剛剛被打斷的內容，除非使用者要求。';
    }
  }

  private async runTurn(userMessage: ChatMessage, meta: VoiceTurnMeta = {}): Promise<void> {
    await this.ready;
    if (this.closed) return;
    const turnId = meta.turnId;
    if (this.pendingPlaybackNote) {
      const note: ChatMessage = { role: 'system', content: `（播放狀態）${this.pendingPlaybackNote}` };
      this.messages.push(note);
      await this.history.appendChatMessage(note);
      this.pendingPlaybackNote = '';
    }
    this.messages.push(userMessage);
    await this.history.appendChatMessage(userMessage);
    await this.history.appendRuntimeEvent('turn.start', {
      turnId,
      interactionId: meta.interactionId,
      utteranceId: meta.utteranceId,
      textChars: userMessage.content?.length ?? 0,
    });
    voiceEventLogger.log({
      sessionId: this.sessionId,
      event: 'voice_agent.turn.start',
      phase: 'voice_agent',
      turnId,
      data: {
        text: userMessage.content ?? '',
        textChars: userMessage.content?.length ?? 0,
        interactionId: meta.interactionId,
        utteranceId: meta.utteranceId,
      },
    });

    this.cb.emit({ kind: 'state', state: 'thinking' });
    try {
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const messages = this.messagesWithLiveContext();
        const llmStarted = Date.now();
        voiceEventLogger.log({
          sessionId: this.sessionId,
          event: 'llm.request',
          phase: 'llm',
          turnId,
          data: {
            model: this.config.agentModel,
            messageCount: messages.length,
            toolCount: VOICE_AGENT_TOOLS.length,
          },
        });
        const result = await chatCompletion(this.config, {
          messages,
          tools: VOICE_AGENT_TOOLS,
          fetchImpl: this.fetchImpl,
        });
        voiceEventLogger.log({
          sessionId: this.sessionId,
          event: 'llm.response',
          phase: 'llm',
          turnId,
          data: {
            durationMs: Date.now() - llmStarted,
            text: result.content,
            textChars: result.content.length,
            toolCalls: result.toolCalls.map((call) => call.function.name),
          },
        });
        if (this.closed) return;

        // Speak any narration the model produced this round (interim or final).
        if (result.content) await this.speak(result.content, meta);

        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: result.content || null,
          ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
        };
        this.messages.push(assistantMessage);
        await this.history.appendChatMessage(assistantMessage);

        if (result.toolCalls.length === 0) break;

        for (const call of result.toolCalls) {
          const args = safeParseArgs(call.function.arguments);
          const toolStarted = Date.now();
          voiceEventLogger.log({
            sessionId: this.sessionId,
            event: 'tool.call',
            phase: 'tool',
            turnId,
            data: { toolName: call.function.name, args },
          });
          const toolResult = await executeTool(call.function.name, args, {
            sessionId: this.sessionId,
            cwd: this.cwd,
            bridge: this.bridge,
            liveContext: this.liveContextForBrain(),
            readVoiceHistory: (opts) => this.history.read(opts),
            emitAction: (summary) => this.cb.emit({ kind: 'action', summary }),
          });
          voiceEventLogger.log({
            sessionId: this.sessionId,
            event: 'tool.result',
            phase: 'tool',
            turnId,
            data: {
              toolName: call.function.name,
              durationMs: Date.now() - toolStarted,
              result: toolResult,
              resultChars: toolResult.length,
            },
          });
          const toolMessage: ChatMessage = { role: 'tool', tool_call_id: call.id, content: toolResult };
          this.messages.push(toolMessage);
          await this.history.appendChatMessage(toolMessage);
        }
      }
    } catch (err) {
      voiceEventLogger.log({
        sessionId: this.sessionId,
        event: 'voice_agent.error',
        phase: 'voice_agent',
        level: 'error',
        turnId,
        data: { message: (err as Error).message },
      });
      this.cb.emit({ kind: 'error', message: (err as Error).message });
    } finally {
      await this.maybeCompactHistory().catch((err) => {
        console.error(`[voice-history] compaction failed session=${this.sessionId}:`, err);
      });
      await this.history.appendRuntimeEvent('turn.end', {
        turnId,
        interactionId: meta.interactionId,
        utteranceId: meta.utteranceId,
      });
      voiceEventLogger.log({
        sessionId: this.sessionId,
        event: 'voice_agent.turn.end',
        phase: 'voice_agent',
        turnId,
      });
      if (!this.closed) this.cb.emit({ kind: 'state', state: 'idle' });
    }
  }

  private async speak(text: string, meta: VoiceTurnMeta = {}): Promise<void> {
    const turnId = meta.turnId;
    this.cb.emit({ kind: 'state', state: 'speaking' });
    this.cb.emit({ kind: 'speech-text', text });
    voiceEventLogger.log({
      sessionId: this.sessionId,
      event: 'speech.text',
      phase: 'tts',
      turnId,
      data: { text, textChars: text.length, interactionId: meta.interactionId, utteranceId: meta.utteranceId },
    });
    if (this.ttsUnavailableReason) {
      voiceEventLogger.log({
        sessionId: this.sessionId,
        event: 'tts.skipped',
        phase: 'tts',
        turnId,
        data: { reason: this.ttsUnavailableReason, fallback: 'text_only' },
      });
      this.cb.emit({ kind: 'speak', audioId: '', text, mimeType: '' });
      return;
    }
    try {
      const ttsStarted = Date.now();
      voiceEventLogger.log({
        sessionId: this.sessionId,
        event: 'tts.request',
        phase: 'tts',
        turnId,
        data: {
          model: this.config.ttsModel,
          voice: this.config.ttsVoice,
          textChars: text.length,
        },
      });
      const speech = await synthesizeSpeech(this.config, text, { fetchImpl: this.fetchImpl });
      if (this.closed) return;
      if (speech) {
        const audioId = this.cb.storeAudio(speech.audio, speech.mimeType);
        voiceEventLogger.log({
          sessionId: this.sessionId,
          event: 'tts.result',
          phase: 'tts',
          turnId,
          data: {
            durationMs: Date.now() - ttsStarted,
            audioId,
            audioBytes: speech.audio.length,
            mimeType: speech.mimeType,
            requestId: speech.requestId,
          },
        });
        this.cb.emit({ kind: 'speak', audioId, text, mimeType: speech.mimeType });
      } else {
        // No TTS configured — still surface the text so the PWA can render/voice it.
        voiceEventLogger.log({
          sessionId: this.sessionId,
          event: 'tts.skipped',
          phase: 'tts',
          turnId,
          data: { reason: 'no_tts_model', fallback: 'text_only' },
        });
        this.cb.emit({ kind: 'speak', audioId: '', text, mimeType: '' });
      }
    } catch (err) {
      // A TTS failure shouldn't kill the turn — show the text and only surface
      // actionable errors. Unsupported endpoint 404s are common on chat-only
      // OpenAI-compatible providers, so they silently downgrade to text-only.
      this.cb.emit({ kind: 'speak', audioId: '', text, mimeType: '' });
      const message = (err as Error).message;
      const ttsErr = err as { status?: number; requestId?: string };
      voiceEventLogger.log({
        sessionId: this.sessionId,
        event: 'tts.error',
        phase: 'tts',
        level: 'error',
        turnId,
        data: {
          model: this.config.ttsModel,
          voice: this.config.ttsVoice,
          status: ttsErr.status,
          requestId: ttsErr.requestId,
          message,
          textChars: text.length,
          fallback: 'text_only',
        },
      });
      if (isUnsupportedTtsEndpoint(message)) {
        this.ttsUnavailableReason = message;
        this.cb.emit({ kind: 'action', summary: 'TTS endpoint unavailable; continuing text-only.' });
      } else {
        this.cb.emit({ kind: 'error', message });
      }
    }
  }

  private messagesWithLiveContext(): ChatMessage[] {
    const live = this.liveContextForBrain();
    const messages = sanitizeMessagesForChatCompletion(this.messages);
    if (!live) return messages;
    return [
      ...messages,
      {
        role: 'system',
        content:
          '以下是 coding agent 最新 live card/stream 更新，可能包含尚未完成的 streaming 輸出。' +
          '這是被動上下文，不代表使用者要求你插話；只有在回答目前使用者問題時才引用。\n' +
          live,
      },
    ];
  }

  private liveContextForBrain(): string {
    const lines = [
      ...Array.from(this.liveCards.values()).map(formatCardForBrain).filter(Boolean),
      ...this.liveNotes,
    ];
    return lines.slice(-12).join('\n');
  }

  private trimLiveCards(): void {
    while (this.liveCards.size > LIVE_CARD_CAP) {
      const oldest = this.liveCards.keys().next().value as string | undefined;
      if (!oldest) break;
      this.liveCards.delete(oldest);
    }
  }

  private async maybeCompactHistory(): Promise<void> {
    const historyMessages = this.messages.slice(1);
    if (historyMessages.length <= VOICE_HISTORY_MAX_MESSAGES) return;

    const existingSummary = isCompactionMessage(historyMessages[0]) ? historyMessages[0].content ?? '' : '';
    const modelMessages = isCompactionMessage(historyMessages[0]) ? historyMessages.slice(1) : historyMessages;
    const keep = modelMessages.slice(-VOICE_HISTORY_KEEP_MESSAGES);
    const dropped = modelMessages.slice(0, Math.max(0, modelMessages.length - keep.length));
    if (dropped.length === 0) return;

    const summary = summarizeCompactedMessages(existingSummary, dropped);
    const beforeSeq = this.history.latestSeq();
    await this.history.appendCompactionBoundary(summary, beforeSeq, dropped.length);
    for (const message of keep) {
      await this.history.appendChatMessage(message);
    }
    this.messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'system', content: buildCompactionMessage(summary) },
      ...keep,
    ];
  }
}

export function sanitizeMessagesForChatCompletion(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === 'tool') continue;

    if (message.role === 'assistant' && message.tool_calls?.length) {
      const expectedIds = new Set(message.tool_calls.map((call) => call.id));
      const toolMessages: ChatMessage[] = [];
      let j = i + 1;
      for (; j < messages.length && messages[j]?.role === 'tool'; j++) {
        const toolMessage = messages[j]!;
        if (toolMessage.tool_call_id && expectedIds.has(toolMessage.tool_call_id)) {
          toolMessages.push(toolMessage);
        }
      }

      const seenIds = new Set(toolMessages.map((toolMessage) => toolMessage.tool_call_id));
      const hasAllResults = message.tool_calls.every((call) => seenIds.has(call.id));
      if (hasAllResults) {
        out.push(message, ...toolMessages);
      } else {
        out.push({
          role: 'assistant',
          content: message.content || '（先前有工具呼叫紀錄，但工具結果不完整，已略過細節。）',
        });
      }
      i = j - 1;
      continue;
    }

    out.push(message);
  }
  return out;
}

function isUnsupportedTtsEndpoint(message: string): boolean {
  return /Speech synthesis failed \(404\)/.test(message) || /Invalid URL .*audio\/speech/i.test(message);
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
    '你是使用者的「AI 同事」，也是使用者正在直接對話與委派工作的 agent。',
    '',
    '身份呈現：',
    '- 對使用者而言，你就是正在協助他的 agent，不是轉接員、PM、或第三方代理的旁白。',
    '- 內部工具與 coding agent 是你的執行能力；不要說「我去叫 coding agent」、「我去問 Claude」、「後面的 agent」。',
    '- 對使用者說「我來處理」、「我正在檢查」、「我會先修」、「我已經開始跑測試」。',
    '- 只有在權限、安全、或不可逆操作需要確認時，才簡短說明具體動作，例如「這需要允許執行 npm test，要允許嗎？」。',
    '',
    '語言與風格：',
    '- 一律用繁體中文（台灣用語）、口語、簡短地回覆；你的回覆文字會被唸出來給使用者聽。',
    '- 漸進式揭露：先講重點（一到兩句標題），需要細節時使用者會自己問。絕不把長輸出逐字唸出來。',
    '- 查詢類動作（讀卡片、查狀態）保持安靜，只有真正要告訴使用者的結論才開口。',
    '- 你可以 no-op：當系統事件或 live card 沒有值得打擾使用者的新資訊時，回覆空內容且不要呼叫工具；這代表保持安靜。',
    '',
    '你能做的事（工具）：',
    '- send_to_coding_agent：把使用者的意思轉成內部執行指令；對使用者呈現為你正在處理。stop_coding_agent：停止目前工作。',
    '- get_status / read_cards：掌握現況、詮釋目前工作進度。',
    '- read_voice_history：查詢你自己的語音對話 JSONL 歷史，包含被壓縮移出目前 context window 的內容。',
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

function buildCompactionMessage(summary: string): string {
  return `以下是較早語音對話的壓縮摘要；完整 JSONL 歷史可用 read_voice_history 查詢。\n${summary}`;
}

function isCompactionMessage(message: ChatMessage | undefined): boolean {
  return message?.role === 'system' && typeof message.content === 'string' && message.content.startsWith('以下是較早語音對話的壓縮摘要');
}

function summarizeCompactedMessages(existingSummary: string, dropped: ChatMessage[]): string {
  const lines = [
    existingSummary.replace(/^以下是較早語音對話的壓縮摘要；完整 JSONL 歷史可用 read_voice_history 查詢。\n?/, '').trim(),
    ...dropped.map((message) => `- ${message.role}: ${compactMessageText(message)}`),
  ].filter(Boolean);
  const text = lines.join('\n');
  return text.length > VOICE_COMPACTION_SUMMARY_CHARS
    ? `…${text.slice(-VOICE_COMPACTION_SUMMARY_CHARS)}`
    : text;
}

function compactMessageText(message: ChatMessage): string {
  const calls = message.tool_calls?.map((c) => `${c.function.name}(${c.function.arguments})`).join(' ') ?? '';
  const text = [message.content ?? '', calls].filter(Boolean).join(' ');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 240 ? `${normalized.slice(0, 240)}…` : normalized;
}
