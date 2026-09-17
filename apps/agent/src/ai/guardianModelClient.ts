// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
//
// Minimal OpenAI-compatible chat-completions client for the guardian
// reviewer. Deliberately not a full SDK: the guardian only ever needs one
// call shape (system + user message in, one assistant message out), and it
// must work against whatever OpenAI-compatible server the user points it at
// (local model servers included), not just a specific vendor's API.
//
// Structured output is requested via `response_format: json_schema` when
// possible, but the caller (`parseGuardianAssessment` in guardian.ts) must
// tolerate plain-text responses too — not every OpenAI-compatible server
// honors `response_format`.

import { recordGuardianServerResult } from './guardianServerState.js';

export interface GuardianModelRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
  enableThinking?: boolean;
  systemPrompt: string;
  userMessage: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
}

function describeGuardianServerError(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') {
    return 'guardian model server timed out';
  }
  return err instanceof Error ? err.message : String(err);
}

/** Returns the parsed JSON object when the server honored structured
 *  output, otherwise the raw assistant message text. Either shape is
 *  accepted by `parseGuardianAssessment`. Throws on transport/HTTP errors —
 *  callers are expected to treat that as fail-closed (deny).
 *
 * Every outcome also updates the daemon-wide server state so the settings
 * UI can show an unreachable server instead of waiting for more denials. */
export async function callGuardianModel(req: GuardianModelRequest): Promise<unknown> {
  const url = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(req.apiKey ? { authorization: `Bearer ${req.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userMessage },
        ],
        max_tokens: req.maxTokens ?? 1024,
        ...(req.enableThinking === undefined ? {} : {
          chat_template_kwargs: { enable_thinking: req.enableThinking },
        }),
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'guardian_assessment', schema: req.schema, strict: true },
        },
      }),
      signal: req.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`guardian model server ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('guardian model server returned an empty completion');
    }
    recordGuardianServerResult(true);
    try {
      return JSON.parse(content);
    } catch {
      // Not JSON — hand the raw text to parseGuardianAssessment's text path.
      return content;
    }
  } catch (err) {
    recordGuardianServerResult(false, describeGuardianServerError(err));
    throw err;
  }
}

export interface GuardianProbeResult {
  ok: boolean;
  error?: string;
  latencyMs: number;
}

/** Lightweight connectivity check for the (possibly draft) reviewer config:
 *  one minimal chat completion with a 1-token budget.
 *
 * `recordState` controls whether the outcome is written to the daemon-wide
 * server state — the settings dialog may test draft values that do not
 * (yet) match the stored config, and those should not poison the state
 * that reviews actually use. */
export async function probeGuardianModel(
  config: { baseUrl: string; model: string; apiKey?: string; enableThinking?: boolean },
  timeoutMs: number,
  recordState = true,
): Promise<GuardianProbeResult> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        ...(config.enableThinking === undefined ? {} : {
          chat_template_kwargs: { enable_thinking: config.enableThinking },
        }),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`guardian model server ${response.status}: ${body.slice(0, 300)}`);
    }
    await response.text().catch(() => undefined);
    if (recordState) recordGuardianServerResult(true);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    const error = describeGuardianServerError(err);
    if (recordState) recordGuardianServerResult(false, error);
    return { ok: false, error, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}
