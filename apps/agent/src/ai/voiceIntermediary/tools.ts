// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * The voice intermediary's tool layer. Seven tools, all bound to EXISTING
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

/**
 * The slice of `SessionManager` the tools depend on. `SessionManager`
 * structurally satisfies this, but narrowing it keeps the tools unit-testable
 * with a tiny fake.
 */
export interface CodingSessionBridge {
  sendUserMessageToSession(sessionId: string, prompt: string, opts?: { interrupt?: boolean }): boolean;
  interruptSession(sessionId: string): Promise<boolean>;
  resolveUserInput(response: ClaudeUserInputResponsePayload): boolean;
  setPermissionLevel(sessionId: string, level: string): Promise<boolean>;
  getCards(sessionId: string, cwd: string, offset?: number, limit?: number): Promise<CardHistoryResponse>;
  getPendingInputRequests(): ClaudeUserInputRequestPayload[];
  getPermissionLevel(sessionId: string): string;
  getActiveSessions(): Array<{ sessionId: string; isStreaming?: boolean; hasPendingInput?: boolean; permissionMode?: string }>;
  isStreaming(sessionId: string): boolean;
}

export interface VoiceToolContext {
  sessionId: string;
  cwd: string;
  bridge: CodingSessionBridge;
  /** Narrate a side effect to the UI log (not spoken). */
  emitAction: (summary: string) => void;
}

export const VOICE_AGENT_TOOLS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'send_to_coding_agent',
      description:
        'Send a prompt/instruction to the coding agent to steer it. Use for "tell it to…", "ask it to…", redirection, answering its open questions. Set interrupt=true ONLY when the user wants to stop the current work and change course now ("no, stop and do X instead"); otherwise the prompt queues politely.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The instruction to give the coding agent, in the project/user language.' },
          interrupt: { type: 'boolean', description: 'Interrupt the in-flight turn before sending. Default false.' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_coding_agent',
      description: 'Interrupt the coding agent\'s current turn without sending a new prompt. Use when the user just says "stop" / "halt".',
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
        'Change the coding agent\'s autonomy. Confirm verbally with the user before widening autonomy. Modes: default, acceptEdits, bypassPermissions, plan, auto (Claude); read-only, default, auto-review, full-access (Codex).',
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
        'Glance at the coding agent right now: is it streaming, is a permission prompt pending (with its request_id and tool), what autonomy mode. Cheap — prefer this over read_cards when the user asks "what\'s it doing?".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_cards',
      description:
        'Read or search the recent coding-agent transcript (messages, tool calls + results, errors). Pass query to filter. Use to interpret what happened and answer detailed questions. Summarize for the user — do NOT read it back verbatim.',
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
    case 'send_to_coding_agent': {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) return 'error: empty prompt';
      const interrupt = !!args.interrupt;
      const ok = bridge.sendUserMessageToSession(sessionId, prompt, { interrupt });
      if (!ok) return 'error: the coding session is not running';
      emitAction(interrupt ? `中斷並引導：${truncate(prompt, 60)}` : `下指令：${truncate(prompt, 60)}`);
      return interrupt ? 'interrupted and sent' : 'sent (will run on the next turn boundary)';
    }

    case 'stop_coding_agent': {
      const ok = await bridge.interruptSession(sessionId);
      if (ok) emitAction('請 coding agent 停下');
      return ok ? 'stopped the current turn' : 'nothing was running to stop';
    }

    case 'respond_to_permission': {
      const requestId = String(args.request_id ?? '').trim();
      const decision = args.decision === 'deny' ? 'deny' : args.decision === 'allow' ? 'allow' : null;
      if (!requestId || !decision) return 'error: request_id and decision (allow|deny) are required';
      const pending = bridge
        .getPendingInputRequests()
        .find((r) => r.requestId === requestId && r.sessionId === sessionId);
      if (!pending) return `error: no pending permission request with id ${requestId} for this session`;
      const payload: ClaudeUserInputResponsePayload = {
        sessionId,
        requestId,
        action: decision,
        response: typeof args.reason === 'string' ? args.reason : undefined,
      };
      const ok = bridge.resolveUserInput(payload);
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
      const active = bridge.getActiveSessions().find((s) => s.sessionId === sessionId);
      const pending = bridge
        .getPendingInputRequests()
        .filter((r) => r.sessionId === sessionId)
        .map((r) => ({
          request_id: r.requestId,
          tool: r.toolName ?? r.title,
          wants: r.toolInput ? briefInput(r.toolInput) : undefined,
        }));
      return JSON.stringify({
        running: active ? bridge.isStreaming(sessionId) : false,
        attached: !!active,
        permission_mode: bridge.getPermissionLevel(sessionId),
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

    default:
      return `error: unknown tool ${name}`;
  }
}
