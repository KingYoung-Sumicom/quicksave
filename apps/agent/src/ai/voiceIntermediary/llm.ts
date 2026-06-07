// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * Minimal OpenAI-compatible chat-completions client for the voice intermediary
 * brain. Raw `fetch` (no SDK) to `{baseUrl}/chat/completions`, mirroring the
 * transcription client in `voiceTranscription.ts` — so STT, the brain, and TTS
 * all ride the SAME cloud provider configured once in `VoiceConfig`.
 */
import type { VoiceConfig } from '@sumicom/quicksave-shared';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI chat message shape (request + response). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  /** Assistant text to speak (may be empty when the turn is pure tool calls). */
  content: string;
  toolCalls: ToolCall[];
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
 * One chat-completions round. Returns the assistant's spoken text plus any tool
 * calls it wants run. The caller drives the tool loop.
 */
export async function chatCompletion(
  config: VoiceConfig,
  opts: {
    messages: ChatMessage[];
    tools: ToolSchema[];
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
  },
): Promise<ChatResult> {
  const model = config.agentModel?.trim();
  if (!model) throw new VoiceLlmError('No agentModel configured for the voice intermediary.');

  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(apiUrl(config.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        model,
        messages: opts.messages,
        tools: opts.tools,
        tool_choice: 'auto',
      }),
      signal: opts.signal,
    });
  } catch (err) {
    throw new VoiceLlmError('Could not reach the chat-completions endpoint.', err);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new VoiceLlmError(`Chat completion failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    throw new VoiceLlmError('Chat-completions response was not valid JSON.', err);
  }

  const message = (data as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  })?.choices?.[0]?.message;

  return {
    content: (message?.content ?? '').trim(),
    toolCalls: Array.isArray(message?.tool_calls) ? message!.tool_calls! : [],
  };
}
