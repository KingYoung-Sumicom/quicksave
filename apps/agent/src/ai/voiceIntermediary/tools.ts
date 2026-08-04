// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * The voice intermediary's tool layer. Silent tools, mostly bound to EXISTING
 * `SessionManager` methods (only `sendUserMessageToSession` is new) plus the
 * workspace memory file. Speaking is NOT a tool — assistant text is synthesized
 * by the session loop; tools are the silent actions the coworker can take.
 *
 * Trust boundary (the user picked "可下指令引導"): steering is free (reversible);
 * irreversible moves — answering a permission prompt, widening autonomy — must
 * only RELAY the user's explicit spoken decision. The schemas say so loudly; the
 * loop additionally never invents a request id.
 */
import type {
  Card,
  CardHistoryResponse,
  ClaudeUserInputRequestPayload,
  ClaudeUserInputResponsePayload,
} from '@sumicom/quicksave-shared';
import { appendMemory, type MemorySection } from './memory.js';
import type { ToolSchema } from './llm.js';
import { formatVoiceHistoryEvent, type VoiceHistoryReadOptions, type VoiceHistoryEvent } from './historyStore.js';

/**
 * The slice of `SessionManager` the tools depend on. `SessionManager`
 * structurally satisfies this, but narrowing it keeps the tools unit-testable
 * with a tiny fake.
 */
export interface CodingSessionBridge {
  sendUserMessageToSession(sessionId: string, prompt: string, opts?: { interrupt?: boolean }): boolean | Promise<boolean>;
  interruptSession(sessionId: string): Promise<boolean>;
  resolveUserInput(response: ClaudeUserInputResponsePayload): boolean | Promise<boolean>;
  setPermissionLevel(sessionId: string, level: string): Promise<boolean>;
  getCards(sessionId: string, cwd: string, offset?: number, limit?: number): Promise<CardHistoryResponse>;
  getPendingInputRequests(): ClaudeUserInputRequestPayload[] | Promise<ClaudeUserInputRequestPayload[]>;
  getPermissionLevel(sessionId: string): string | Promise<string>;
  getActiveSessions(): Array<{ sessionId: string; isStreaming?: boolean; hasPendingInput?: boolean; permissionMode?: string }> | Promise<Array<{ sessionId: string; isStreaming?: boolean; hasPendingInput?: boolean; permissionMode?: string }>>;
  isStreaming(sessionId: string): boolean | Promise<boolean>;
}

export interface VoiceToolContext {
  sessionId: string;
  cwd: string;
  bridge: CodingSessionBridge;
  /** Recent live card events already observed by the voice intermediary. */
  liveContext?: string;
  /** Read prior voice-agent JSONL history, including compacted context. */
  readVoiceHistory?: (opts: VoiceHistoryReadOptions) => Promise<VoiceHistoryEvent[]>;
  proposeCodingChange?: (proposal: { prompt: string; spokenSummary: string }) => string;
  confirmCodingChange?: (proposalId?: string, opts?: { interrupt?: boolean }) => string | Promise<string>;
  cancelCodingChange?: (reason?: string) => string;
  /** Narrate a side effect to the UI log (not spoken). */
  emitAction: (summary: string) => void;
}

export const VOICE_AGENT_TOOLS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'send_to_coding_agent',
      description:
        'Legacy escape hatch. Prefer investigate_with_coding_agent for read-only investigation and propose_coding_change/confirm_coding_change for edits or other mutations. Only use this directly for already-confirmed, reversible steering. Do not use it to bypass mutation confirmation.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The internal implementation instruction, in the project/user language.' },
          interrupt: { type: 'boolean', description: 'Interrupt the in-flight turn before sending. Default false.' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'investigate_with_coding_agent',
      description:
        'Directly dispatch read-only investigation, inspection, diagnosis, planning, log/code/status review, or summarization. Use this when the user asks you to look into something and no files, commits, services, data, permissions, or external state should be changed. Dispatch silently first; after the tool result, tell the user what you are checking in one plain spoken sentence with no Markdown, list, or visual formatting.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The internal read-only investigation instruction. It must explicitly say not to modify files when appropriate.' },
          interrupt: { type: 'boolean', description: 'Interrupt the in-flight turn before sending. Default false; use only if the user wants to change course now.' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_coding_change',
      description:
        'Create a pending confirmation proposal for mutating work. Use before edits, commits, restarts, deletes, deploys, migrations, permission/autonomy widening, or other consequential actions. This does NOT send anything to the coding session. After this tool, the entire final user-facing reply must be the spoken_summary, with no preamble, repetition, Markdown, list, or visual formatting. If the user changes details, make a new proposal instead of confirming the old one.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The internal instruction to send only after explicit user confirmation.' },
          spoken_summary: { type: 'string', description: 'A complete, short confirmation question describing exactly what would be sent. Write it as one plain, directly speakable utterance with no Markdown, bullets, line breaks, raw identifiers, or visual formatting.' },
        },
        required: ['prompt', 'spoken_summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_coding_change',
      description:
        'After the user explicitly confirms the currently pending coding-change proposal, send it to the coding session. Do not call this for vague acknowledgements, edits to the proposal, or if no proposal is pending.',
      parameters: {
        type: 'object',
        properties: {
          proposal_id: { type: 'string', description: 'Optional proposal id from propose_coding_change. Omit to confirm the latest pending proposal.' },
          interrupt: { type: 'boolean', description: 'Interrupt the in-flight turn before sending. Default false; use only if the user explicitly wants to stop current work and change course.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_coding_change',
      description:
        'Cancel the pending coding-change proposal when the user says no, changes direction, or asks to hold off. If the user supplies new details, cancel/replace with propose_coding_change rather than confirming.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Short reason for cancellation or replacement.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_coding_agent',
      description: 'Interrupt the current implementation turn without sending a new prompt. Use when the user just says "stop" / "halt"; tell the user you stopped the current work.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'respond_to_permission',
      description:
        'Relay the user\'s spoken decision to a PENDING permission prompt. NEVER decide on your own: first speak what the tool wants and ask the user, then call this with their explicit allow/deny. Get request_id from get_status. Irreversible actions (push, delete, deploy, send) require a clear spoken yes.',
      parameters: {
        type: 'object',
        properties: {
          request_id: { type: 'string', description: 'The pending request id from get_status.' },
          decision: { type: 'string', enum: ['allow', 'deny'], description: 'The user\'s explicit decision.' },
          reason: { type: 'string', description: 'Optional note to attach (e.g. why denied).' },
        },
        required: ['request_id', 'decision'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_permission_mode',
      description:
        'Change implementation autonomy. Confirm verbally with the user before widening autonomy. Modes: default, acceptEdits, bypassPermissions, plan, auto (Claude); read-only, default, auto-review, full-access (Codex).',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', description: 'The permission/autonomy mode to switch to.' },
        },
        required: ['mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_status',
      description:
        'Read only runtime state: whether the coding session is attached or running, whether a permission prompt is pending, and the autonomy mode. This tool cannot tell you what work changed, what the latest manual prompt requested, or what tests/commits produced; use read_cards for those facts and use both tools for a broad progress briefing. Its JSON result is evidence, not a response format. Convert it to one short plain spoken paragraph without JSON labels, Markdown, lists, or visual formatting.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_cards',
      description:
        'Read/search the recent coding transcript to ground current progress, including manual prompts, messages, tool calls and results, errors, tests, commits, and diffs. Use whenever the user asks what has happened or what the current coding work produced, even if restored voice context appears sufficient; omit query for a general progress scan. Source cards may contain Markdown and technical formatting. Never preserve or quote that layout: convert the evidence into one short plain spoken paragraph, and do not say you are reading another agent.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional case-insensitive substring filter.' },
          limit: { type: 'number', description: 'How many recent cards to scan (1-50, default 20).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Persist a durable fact to the workspace memory so future voice sessions know it. Use when the user states a standing preference, a boundary/decision, or a project fact ("always run lint", "never push to main without asking", "tests are pnpm test").',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The fact to remember, phrased concisely.' },
          section: { type: 'string', enum: ['preference', 'decision', 'fact', 'note'], description: 'Which section it belongs in.' },
        },
        required: ['note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_voice_history',
      description:
        'Ground earlier spoken context by searching/browsing this voice agent\'s own persisted JSONL history, including messages before compaction. This is the default source when the user refers to "剛剛", "前面", "那個", "繼續", "照剛才", asks what they told you earlier, asks why you made a voice-agent decision, or active context lacks older voice conversation details. Use it instead of guessing. Old replies may contain legacy Markdown; treat that as data, never imitate it, and summarize as plain spoken language rather than reading raw history aloud.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional case-insensitive search text.' },
          limit: { type: 'number', description: 'How many recent matching history events to read (1-100, default 20).' },
          before_seq: { type: 'number', description: 'Only read events before this sequence number.' },
          include_runtime_events: { type: 'boolean', description: 'Include runtime/log events. Default false.' },
        },
      },
    },
  },
];

const MAX_CARD_CONTENT = 220;

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function briefInput(input: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(input);
    return truncate(s, 120);
  } catch {
    return '';
  }
}

/** One compact line per card for the brain to reason over (not for TTS). */
export function formatCardForBrain(card: Card): string {
  switch (card.type) {
    case 'user':
      return `[你] ${truncate(card.text, MAX_CARD_CONTENT)}`;
    case 'assistant_text':
      return `[Claude] ${truncate(card.text, MAX_CARD_CONTENT)}`;
    case 'thinking':
      return `[思考] ${truncate(card.text, 120)}`;
    case 'tool_call': {
      const head = `[工具] ${card.toolName}(${briefInput(card.toolInput)})`;
      if (!card.result) return `${head} …進行中`;
      const tag = card.result.isError ? '錯誤: ' : '→ ';
      return `${head} ${tag}${truncate(card.result.content, MAX_CARD_CONTENT)}`;
    }
    case 'subagent':
      return `[子代理${card.subagentType ? ' ' + card.subagentType : ''}] ${truncate(card.description, 120)} — ${card.status}${card.summary ? ': ' + truncate(card.summary, 160) : ''}`;
    case 'system':
      return `[系統${card.subtype ? '/' + card.subtype : ''}] ${truncate(card.text, MAX_CARD_CONTENT)}`;
    case 'generated_image':
      return `[圖片] ${truncate(card.prompt, 120)} (${card.status})`;
    case 'artifact':
      return `[文件] ${truncate(card.artifact?.title ?? '', 120)}`;
    case 'recovery_suggested':
      return `[復原建議] ${truncate(card.reason, 160)}`;
    default:
      return '';
  }
}

/**
 * Execute one tool call and return the string result fed back to the model.
 * Never throws on expected failures (returns an explanatory string) so the loop
 * keeps going; only programmer errors propagate.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: VoiceToolContext,
): Promise<string> {
  const { sessionId, cwd, bridge, emitAction } = ctx;

  switch (name) {
    case 'investigate_with_coding_agent': {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) return 'error: empty prompt';
      const interrupt = !!args.interrupt;
      const ok = await bridge.sendUserMessageToSession(sessionId, prompt, { interrupt });
      if (!ok) return 'error: the coding session is not running';
      emitAction(interrupt ? `改查：${truncate(prompt, 60)}` : `開始查：${truncate(prompt, 60)}`);
      return interrupt ? 'investigation interrupted current turn and was sent' : 'investigation dispatched';
    }

    case 'propose_coding_change': {
      if (!ctx.proposeCodingChange) return 'error: coding change proposals are unavailable';
      const prompt = String(args.prompt ?? '').trim();
      const spokenSummary = String(args.spoken_summary ?? '').trim();
      if (!prompt || !spokenSummary) return 'error: prompt and spoken_summary are required';
      const proposalId = ctx.proposeCodingChange({ prompt, spokenSummary });
      emitAction(`等待確認：${truncate(spokenSummary, 60)}`);
      return JSON.stringify({
        pending_proposal_id: proposalId,
        spoken_summary: spokenSummary,
        instruction: 'Ask the user to confirm this proposal before calling confirm_coding_change. Do not say it has been sent yet.',
      });
    }

    case 'confirm_coding_change': {
      if (!ctx.confirmCodingChange) return 'error: coding change confirmation is unavailable';
      return await ctx.confirmCodingChange(
        typeof args.proposal_id === 'string' ? args.proposal_id : undefined,
        { interrupt: args.interrupt === true },
      );
    }

    case 'cancel_coding_change': {
      if (!ctx.cancelCodingChange) return 'error: coding change cancellation is unavailable';
      return ctx.cancelCodingChange(typeof args.reason === 'string' ? args.reason : undefined);
    }

    case 'send_to_coding_agent': {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) return 'error: empty prompt';
      const interrupt = !!args.interrupt;
      const ok = await bridge.sendUserMessageToSession(sessionId, prompt, { interrupt });
      if (!ok) return 'error: the coding session is not running';
      emitAction(interrupt ? `改做：${truncate(prompt, 60)}` : `開始處理：${truncate(prompt, 60)}`);
      return interrupt ? 'interrupted and sent' : 'sent (will run on the next turn boundary)';
    }

    case 'stop_coding_agent': {
      const ok = await bridge.interruptSession(sessionId);
      if (ok) emitAction('已停止目前工作');
      return ok ? 'stopped the current turn' : 'nothing was running to stop';
    }

    case 'respond_to_permission': {
      const requestId = String(args.request_id ?? '').trim();
      const decision = args.decision === 'deny' ? 'deny' : args.decision === 'allow' ? 'allow' : null;
      if (!requestId || !decision) return 'error: request_id and decision (allow|deny) are required';
      const pending = (await bridge
        .getPendingInputRequests())
        .find((r) => r.requestId === requestId && r.sessionId === sessionId);
      if (!pending) return `error: no pending permission request with id ${requestId} for this session`;
      const payload: ClaudeUserInputResponsePayload = {
        sessionId,
        requestId,
        action: decision,
        response: typeof args.reason === 'string' ? args.reason : undefined,
      };
      const ok = await bridge.resolveUserInput(payload);
      if (ok) emitAction(`${decision === 'allow' ? '核准' : '拒絕'}權限：${pending.toolName ?? pending.title}`);
      return ok ? `relayed ${decision} for ${pending.toolName ?? 'request'}` : 'error: failed to relay the decision';
    }

    case 'set_permission_mode': {
      const mode = String(args.mode ?? '').trim();
      if (!mode) return 'error: mode is required';
      const ok = await bridge.setPermissionLevel(sessionId, mode);
      if (ok) emitAction(`權限模式 → ${mode}`);
      return ok ? `permission mode set to ${mode}` : `error: "${mode}" was rejected for this agent`;
    }

    case 'get_status': {
      const [activeSessions, pendingRequests, permissionMode, streaming] = await Promise.all([
        bridge.getActiveSessions(),
        bridge.getPendingInputRequests(),
        bridge.getPermissionLevel(sessionId),
        bridge.isStreaming(sessionId),
      ]);
      const active = activeSessions.find((s) => s.sessionId === sessionId);
      const pending = pendingRequests
        .filter((r) => r.sessionId === sessionId)
        .map((r) => ({
          request_id: r.requestId,
          tool: r.toolName ?? r.title,
          wants: r.toolInput ? briefInput(r.toolInput) : undefined,
        }));
      return JSON.stringify({
        running: active ? streaming : false,
        attached: !!active,
        permission_mode: permissionMode,
        pending_permissions: pending,
      });
    }

    case 'read_cards': {
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
      const query = typeof args.query === 'string' ? args.query.toLowerCase().trim() : '';
      let resp: CardHistoryResponse;
      try {
        resp = await bridge.getCards(sessionId, cwd, 0, limit);
      } catch (err) {
        return `error reading cards: ${(err as Error).message}`;
      }
      let lines = resp.cards.map(formatCardForBrain).filter(Boolean);
      if (ctx.liveContext?.trim()) {
        lines.push(...ctx.liveContext.split('\n').map((l) => l.trim()).filter(Boolean));
      }
      if (query) lines = lines.filter((l) => l.toLowerCase().includes(query));
      if (lines.length === 0) return query ? `no cards matched "${query}"` : 'no transcript yet';
      return lines.join('\n');
    }

    case 'remember': {
      const note = String(args.note ?? '').trim();
      if (!note) return 'error: note is required';
      const section = (['preference', 'decision', 'fact', 'note'] as MemorySection[]).includes(args.section as MemorySection)
        ? (args.section as MemorySection)
        : 'note';
      await appendMemory(cwd, note, section);
      emitAction(`記住：${truncate(note, 60)}`);
      return 'remembered';
    }

    case 'read_voice_history': {
      if (!ctx.readVoiceHistory) return 'error: voice history is unavailable';
      const events = await ctx.readVoiceHistory({
        query: typeof args.query === 'string' ? args.query : undefined,
        limit: Math.min(100, Math.max(1, Number(args.limit) || 20)),
        beforeSeq: Number.isFinite(Number(args.before_seq)) ? Number(args.before_seq) : undefined,
        includeRuntimeEvents: args.include_runtime_events === true,
      });
      if (events.length === 0) return 'no voice history matched';
      return events.map(formatVoiceHistoryEvent).join('\n');
    }

    default:
      return `error: unknown tool ${name}`;
  }
}
