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
  VoiceAgentTraceEntry,
  VoiceConfig,
} from '@sumicom/quicksave-shared';
import { responseCompletion, type ChatMessage, type FetchLike } from './llm.js';
import { synthesizeSpeech, type SynthesizedSpeech } from './tts.js';
import { VOICE_AGENT_TOOLS, executeTool, formatCardForBrain, type CodingSessionBridge } from './tools.js';
import { loadMemory } from './memory.js';
import { voiceEventLogger } from '../voiceLog.js';
import { VoiceHistoryStore, type VoiceHistoryEvent } from './historyStore.js';

/** Upper bound on tool round-trips per utterance — a runaway-loop backstop. */
const MAX_TOOL_TURNS = 6;
const LIVE_CARD_CAP = 30;
const VOICE_HISTORY_MAX_MESSAGES = 80;
const VOICE_HISTORY_KEEP_MESSAGES = 40;
const VOICE_COMPACTION_SUMMARY_CHARS = 4000;

interface PendingCodingChange {
  id: string;
  prompt: string;
  spokenSummary: string;
  createdAt: number;
}

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
  /** Lets the daemon stream TTS through its WebRTC peer while this session lives in a worker. */
  speechSynthesizer?: (config: VoiceConfig, text: string) => Promise<SynthesizedSpeech | null>;
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
  private readonly speechSynthesizer: (config: VoiceConfig, text: string) => Promise<SynthesizedSpeech | null>;

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
  private pendingCodingChange: PendingCodingChange | null = null;
  private codingChangeSeq = 0;
  private traceSeq = 0;

  constructor(opts: VoiceSessionOpts) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.config = opts.config;
    this.bridge = opts.bridge;
    this.cb = opts.callbacks;
    this.fetchImpl = opts.fetchImpl;
    this.history = opts.historyStore ?? new VoiceHistoryStore(this.sessionId);
    this.speechSynthesizer = opts.speechSynthesizer
      ?? ((config, speechText) => synthesizeSpeech(config, speechText, { fetchImpl: this.fetchImpl }));
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
    const proposalState = restorePendingCodingChange(restored.events);
    this.pendingCodingChange = proposalState.pending;
    this.codingChangeSeq = proposalState.latestSeq;
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
        '請使用單段純口語，不要使用 Markdown 或視覺排版。若沒有值得打擾使用者的新資訊，請 no-op：回覆空內容且不要呼叫任何工具。',
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
    this.emitTrace('lifecycle', 'turn.started', {
      text: userMessage.content ?? '',
      interactionId: meta.interactionId,
      utteranceId: meta.utteranceId,
    }, turnId);

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
        this.emitTrace('llm', 'llm.request', {
          model: this.config.agentModel,
          messages,
          tools: VOICE_AGENT_TOOLS.map((tool) => tool.function.name),
        }, turnId);
        const result = await responseCompletion(this.config, {
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
        this.emitTrace('llm', 'llm.response', {
          content: result.content,
          toolCalls: result.toolCalls,
          reasoningSummary: result.reasoningSummary,
        }, turnId, Date.now() - llmStarted);
        if (this.closed) return;

        // If the model requested tools, run them before speaking. This prevents
        // "I'll do it" preambles from playing before the dispatch/proposal state
        // actually exists; the next LLM round can narrate the tool result.
        const shouldSpeakNow = result.content && result.toolCalls.length === 0;
        if (shouldSpeakNow) await this.speak(result.content, meta);

        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: result.content || null,
          ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
          ...(result.reasoningItems.length ? { reasoning_items: result.reasoningItems } : {}),
          ...(result.reasoningItems.length ? {
            reasoning_source: `${this.config.baseUrl.trim().replace(/\/+$/, '')}|${this.config.agentModel?.trim()}`,
          } : {}),
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
          this.emitTrace('tool', 'tool.call', {
            toolName: call.function.name,
            args,
            toolCallId: call.id,
          }, turnId);
          const toolResult = await executeTool(call.function.name, args, {
            sessionId: this.sessionId,
            cwd: this.cwd,
            bridge: this.bridge,
            liveContext: this.liveContextForBrain(),
            readVoiceHistory: (opts) => this.history.read(opts),
            proposeCodingChange: (proposal) => this.proposeCodingChange(proposal),
            confirmCodingChange: (proposalId, opts) => this.confirmCodingChange(proposalId, opts),
            cancelCodingChange: (reason) => this.cancelCodingChange(reason),
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
          this.emitTrace('tool', 'tool.result', {
            toolName: call.function.name,
            toolCallId: call.id,
            result: toolResult,
          }, turnId, Date.now() - toolStarted);
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
      this.emitTrace('lifecycle', 'turn.ended', {}, turnId);
      if (!this.closed) this.cb.emit({ kind: 'state', state: 'idle' });
    }
  }

  private async speak(text: string, meta: VoiceTurnMeta = {}): Promise<void> {
    const turnId = meta.turnId;
    this.cb.emit({ kind: 'state', state: 'speaking' });
    this.cb.emit({ kind: 'speech-text', text });
    this.emitTrace('speech', 'speech.proposed', { text }, turnId);
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
      const speech = await this.speechSynthesizer(this.config, text);
      if (this.closed) return;
      if (speech) {
        const audioId = speech.audio.length > 0 ? this.cb.storeAudio(speech.audio, speech.mimeType) : '';
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
            streamed: speech.streamed === true,
            interrupted: speech.interrupted === true,
          },
        });
        this.cb.emit({
          kind: 'speak',
          audioId,
          text,
          mimeType: speech.mimeType,
          streamed: speech.streamed,
          interrupted: speech.interrupted,
        });
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
    const messages = sanitizeMessagesForResponses(this.messages);
    return [
      ...messages,
      ...(live ? [{
        role: 'system',
        content:
          '以下是 coding agent 最新 live card/stream 更新，可能包含尚未完成的 streaming 輸出。' +
          '這是被動上下文，不代表使用者要求你插話；只有在回答目前使用者問題時才引用。\n' +
          live,
      } satisfies ChatMessage] : []),
      { role: 'system', content: buildRuntimeContextReminder() },
    ];
  }

  private liveContextForBrain(): string {
    const lines = [
      ...Array.from(this.liveCards.values()).map(formatCardForBrain).filter(Boolean),
      ...this.liveNotes,
    ];
    return lines.slice(-12).join('\n');
  }

  private proposeCodingChange(proposal: { prompt: string; spokenSummary: string }): string {
    const id = `voice-change-${++this.codingChangeSeq}`;
    this.pendingCodingChange = {
      id,
      prompt: proposal.prompt,
      spokenSummary: proposal.spokenSummary,
      createdAt: Date.now(),
    };
    void this.history.appendRuntimeEvent('coding_change.proposed', {
      proposalId: id,
      prompt: proposal.prompt,
      spokenSummary: proposal.spokenSummary,
    });
    return id;
  }

  private async confirmCodingChange(proposalId?: string, opts: { interrupt?: boolean } = {}): Promise<string> {
    const pending = this.pendingCodingChange;
    if (!pending) return 'error: no pending coding change proposal to confirm';
    if (proposalId && proposalId !== pending.id) {
      return `error: pending proposal is ${pending.id}, not ${proposalId}`;
    }
    const ok = await this.bridge.sendUserMessageToSession(this.sessionId, pending.prompt, { interrupt: opts.interrupt === true });
    if (!ok) return 'error: the coding session is not running';
    this.pendingCodingChange = null;
    this.cb.emit({ kind: 'action', summary: `已送出：${pending.spokenSummary}` });
    void this.history.appendRuntimeEvent('coding_change.confirmed', {
      proposalId: pending.id,
      promptChars: pending.prompt.length,
      ageMs: Date.now() - pending.createdAt,
    });
    return 'confirmed and sent (may queue until the current turn boundary)';
  }

  private cancelCodingChange(reason?: string): string {
    const pending = this.pendingCodingChange;
    if (!pending) return 'no pending coding change proposal';
    this.pendingCodingChange = null;
    void this.history.appendRuntimeEvent('coding_change.cancelled', {
      proposalId: pending.id,
      reason,
    });
    this.cb.emit({ kind: 'action', summary: `取消待確認修改：${pending.spokenSummary}` });
    return reason ? `cancelled pending proposal: ${reason}` : 'cancelled pending proposal';
  }

  private trimLiveCards(): void {
    while (this.liveCards.size > LIVE_CARD_CAP) {
      const oldest = this.liveCards.keys().next().value as string | undefined;
      if (!oldest) break;
      this.liveCards.delete(oldest);
    }
  }

  private emitTrace(
    phase: VoiceAgentTraceEntry['phase'],
    event: string,
    data: Record<string, unknown>,
    turnId?: string,
    durationMs?: number,
  ): void {
    this.cb.emit({
      kind: 'trace',
      entry: {
        id: `${this.sessionId}:${++this.traceSeq}`,
        timestamp: Date.now(),
        phase,
        event,
        turnId,
        durationMs,
        data,
      },
    });
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

export function sanitizeMessagesForResponses(messages: readonly ChatMessage[]): ChatMessage[] {
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
    '- 漸進式揭露：預設只講 1 到 3 句，約 30 秒內可以唸完；需要細節時使用者會自己問。',
    '- 篩選少量最重要資訊：完成了什麼、目前卡在哪裡、下一步是什麼。不要一次講完整背景。',
    '- 絕不把長輸出、card、log、diff、測試輸出逐字唸出來；只摘要成口語結論。',
    '- 不要唸檔名、hash、路徑、commit id、UUID、URL 參數、錯誤碼、程式碼片段；若重要，改成概念性描述。',
    '- 如果有多個結果，最多提供 3 項資訊，但要用連續的口語句子表達，不要列點。沒有值得告知的新資訊時就 no-op。',
    '- 查詢類動作（讀卡片、查狀態）保持安靜，只有真正要告訴使用者的結論才開口。',
    '- 你可以 no-op：當系統事件或 live card 沒有值得打擾使用者的新資訊時，回覆空內容且不要呼叫工具；這代表保持安靜。',
    '',
    'grounding 規則：',
    '- 事實性、回顧性、狀態性、原因判斷、承接前文的回答必須有依據；依據可以來自目前對話、壓縮摘要、memory、live cards、get_status、read_cards、read_voice_history。',
    '- 當使用者說「剛剛」「前面」「那個」「繼續」「照剛才」「我們剛才」「你記得嗎」或類似模糊指代，而目前 context 不足時，先安靜使用 read_voice_history 補齊，不要憑印象猜。',
    '- 判斷 coding work 做了什麼、最新人工 prompt、測試、commit、錯誤或產出時，用 read_cards；判斷是否執行中、等待權限或連線狀態時，用 get_status。一般進度問題可能需要兩者，不要把 voice history 或 pending proposal 當成 coding session 現況。',
    '- 如果查不到足夠紀錄，就明說「我目前沒有看到足夠紀錄」，不要補腦。',
    '- 新指令、簡短確認、互動提示、權限確認流程中的固定問句可以直接回覆，不需要每句都查紀錄。',
    '',
    'coding 指令 dispatch 規則：',
    '- read-only 調查、檢查、查 log、讀 code、整理狀態、提出方案，用 investigate_with_coding_agent 直接送出；送出前不要先講一段承諾，送出後再簡短告知「我正在查…」。',
    '- 會修改檔案、commit、restart、delete、deploy、migration、改資料庫、放寬權限、或其他有副作用的工作，先用 propose_coding_change 建立待確認 proposal；不要直接送出。',
    '- proposal 要用一句短話請使用者確認，例如「確認一下：我要送出修改首頁高度並跑相關測試。要執行嗎？」',
    '- 使用者確認後，才用 confirm_coding_change 送出；送出前不要再講 preamble，工具成功後只說「已送出」或「已排隊」。',
    '- 使用者否定、改方向、加限制時，不要 confirm；取消或替換 proposal，重新確認。',
    '- 不要用口頭「我會做」取代工具呼叫；如果該送出就 call tool，如果該確認就建立 proposal。',
    '',
    '你能做的事（工具）：',
    '- investigate_with_coding_agent：直接派發 read-only 調查。propose_coding_change / confirm_coding_change / cancel_coding_change：處理修改類工作的確認流程。stop_coding_agent：停止目前工作。',
    '- send_to_coding_agent：舊相容工具，只有已確認且可回復的 steering 才使用；一般情況優先用上面的拆分工具。',
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
    '',
    '最終輸出格式（最高優先）：',
    '你的最終 user-facing reply 與 spoken_summary 是直接送進語音合成的口語講稿，不是聊天介面文章。',
    '只輸出實際要說出口的話，使用一個自然段落與 1 到 3 個完整句子。可以使用自然口語標點，但禁止標題、條列、編號、表格、Markdown、粗體符號、反引號、程式碼框、emoji，以及為排版加入的換行。',
    '若有多項資訊，使用「先說」「另外」「最後」等口語連接詞串成句子。必要的技術概念可以自然說出，但不要加入視覺強調或原始技術識別字串。',
    '以上格式限制只適用於 user-facing reply 與 spoken_summary，不限制內部 tool arguments。送出前先檢查一次，確保內容看起來就是可直接朗讀的逐字稿。',
  ].join('\n');
}

export function buildRuntimeContextReminder(): string {
  return [
    '本次 voice intermediary instance 可能在 coding session 已有未知變更後才啟動；恢復的 voice history 與 pending proposal 不是目前 coding 進度的權威來源。涉及最新進度或工作結果時，先用 read_cards 取得現況；get_status 只提供執行、連線與權限狀態。',
    '恢復的舊 assistant 訊息可能包含 Markdown、條列與視覺排版；它們只代表歷史內容，不代表目前輸出風格，禁止模仿其格式。',
    '最終 user-facing reply 必須是單段、可直接朗讀的純口語，不使用 Markdown、條列、編號、反引號或排版換行。',
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

function restorePendingCodingChange(events: readonly VoiceHistoryEvent[]): {
  pending: PendingCodingChange | null;
  latestSeq: number;
} {
  let pending: PendingCodingChange | null = null;
  let latestSeq = 0;
  for (const event of events) {
    if (event.type !== 'runtime_event' || !event.data || typeof event.data !== 'object') continue;
    const data = event.data as Record<string, unknown>;
    const proposalId = typeof data.proposalId === 'string' ? data.proposalId : '';
    const match = /^voice-change-(\d+)$/.exec(proposalId);
    if (match) latestSeq = Math.max(latestSeq, Number(match[1]));
    if (event.event === 'coding_change.proposed') {
      const prompt = typeof data.prompt === 'string' ? data.prompt : '';
      const spokenSummary = typeof data.spokenSummary === 'string' ? data.spokenSummary : '';
      pending = proposalId && prompt && spokenSummary
        ? { id: proposalId, prompt, spokenSummary, createdAt: event.ts }
        : null;
    } else if (
      (event.event === 'coding_change.confirmed' || event.event === 'coding_change.cancelled')
      && pending?.id === proposalId
    ) {
      pending = null;
    }
  }
  return { pending, latestSeq };
}
