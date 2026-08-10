// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * Minimal OpenAI-compatible Responses client for the voice intermediary brain.
 * Raw `fetch` (no SDK) to `{baseUrl}/responses`, mirroring the
 * transcription client in `voiceTranscription.ts` — so STT, the brain, and TTS
 * all ride the SAME cloud provider configured once in `VoiceConfig`.
 */
import type { VoiceConfig } from '@sumicom/quicksave-shared';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Provider reasoning state safe to persist and replay as Responses input. */
export interface ResponseReasoningItem {
  type: 'reasoning';
  id?: string;
  status?: string;
  summary?: unknown[];
  encrypted_content?: string;
}

/** OpenAI chat message shape (request + response). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Responses reasoning items emitted immediately before this assistant turn. */
  reasoning_items?: ResponseReasoningItem[];
  /** Endpoint/model identity that produced `reasoning_items`. */
  reasoning_source?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface BrainResult {
  /** Assistant text to speak (may be empty when the turn is pure tool calls). */
  content: string;
  toolCalls: ToolCall[];
  reasoningItems: ResponseReasoningItem[];
  reasoningSummary: string[];
}

export class VoiceLlmError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'VoiceLlmError';
  }
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`;
}

function authHeaders(config: VoiceConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  return headers;
}

/** `fetch` is injectable for tests. */
export type FetchLike = typeof fetch;

/**
 * One Responses round. Returns the assistant's spoken text plus any tool
 * calls it wants run. The caller drives the tool loop.
 */
export async function responseCompletion(
  config: VoiceConfig,
  opts: {
    messages: ChatMessage[];
    tools: ToolSchema[];
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
  },
): Promise<BrainResult> {
  const model = config.agentModel?.trim();
  if (!model) throw new VoiceLlmError('No agentModel configured for the voice intermediary.');

  const doFetch = opts.fetchImpl ?? fetch;
  const reasoningEffort = config.agentReasoningEffort;
  let res: Response;
  try {
    res = await doFetch(apiUrl(config.baseUrl, '/responses'), {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        model,
        input: toResponseInput(opts.messages, reasoningSource(config, model)),
        tools: opts.tools.map((tool) => ({ type: 'function', ...tool.function })),
        tool_choice: 'auto',
        store: false,
        ...(reasoningEffort ? {
          reasoning: {
            effort: reasoningEffort,
            ...(reasoningEffort === 'none' ? {} : { summary: 'auto' }),
          },
          ...(reasoningEffort === 'none' ? {} : { include: ['reasoning.encrypted_content'] }),
        } : {}),
      }),
      signal: opts.signal,
    });
  } catch (err) {
    throw new VoiceLlmError('Could not reach the Responses endpoint.', err);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new VoiceLlmError(`Response failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    throw new VoiceLlmError('Responses response was not valid JSON.', err);
  }

  const output = (data as { output?: unknown[] })?.output;
  if (!Array.isArray(output)) throw new VoiceLlmError('Responses response did not contain an output array.');

  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  const reasoningItems: ResponseReasoningItem[] = [];
  const reasoningSummary: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type === 'reasoning') {
      const reasoningItem = sanitizeReasoningItem(record);
      for (const part of reasoningItem.summary ?? []) {
        if (!part || typeof part !== 'object') continue;
        const summary = part as Record<string, unknown>;
        if (typeof summary.text === 'string') reasoningSummary.push(summary.text);
      }
      // With `store: false`, only encrypted content is replayable on a later
      // request. Keep summaries observable, but never persist plaintext CoT.
      if (reasoningItem.encrypted_content) reasoningItems.push(reasoningItem);
    } else if (record.type === 'message' && Array.isArray(record.content)) {
      for (const part of record.content) {
        if (!part || typeof part !== 'object') continue;
        const content = part as Record<string, unknown>;
        if (content.type === 'output_text' && typeof content.text === 'string') text.push(content.text);
      }
    } else if (
      record.type === 'function_call'
      && typeof record.name === 'string'
      && typeof record.arguments === 'string'
    ) {
      const callId = typeof record.call_id === 'string'
        ? record.call_id
        : typeof record.id === 'string' ? record.id : '';
      if (!callId) continue;
      toolCalls.push({
        id: callId,
        type: 'function',
        function: { name: record.name, arguments: record.arguments },
      });
    }
  }

  return {
    content: text.join('\n').trim(),
    toolCalls,
    reasoningItems,
    reasoningSummary,
  };
}

function toResponseInput(
  messages: readonly ChatMessage[],
  currentReasoningSource: string,
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.tool_call_id) {
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: message.content ?? '',
        });
      }
      continue;
    }
    if (!message.reasoning_source || message.reasoning_source === currentReasoningSource) {
      input.push(...(message.reasoning_items ?? []).map((item) => ({ ...item })));
    }
    if (message.content) input.push({ role: message.role, content: message.content });
    for (const call of message.tool_calls ?? []) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  return input;
}

function reasoningSource(config: VoiceConfig, model: string): string {
  return `${config.baseUrl.trim().replace(/\/+$/, '')}|${model}`;
}

function sanitizeReasoningItem(record: Record<string, unknown>): ResponseReasoningItem {
  return {
    type: 'reasoning',
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    ...(Array.isArray(record.summary) ? { summary: record.summary } : {}),
    ...(typeof record.encrypted_content === 'string' ? { encrypted_content: record.encrypted_content } : {}),
  };
}
