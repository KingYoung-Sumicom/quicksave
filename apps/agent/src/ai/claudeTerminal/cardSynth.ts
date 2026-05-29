// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * CardSynth — merge cards arriving from two channels (hooks + JSONL) into a
 * single deduplicated stream for `ClaudeTerminalProvider`.
 *
 * Why two channels:
 *   - Hook events (`PreToolUse` / `PostToolUse`) fire within a few ms of the
 *     model deciding to use a tool / receiving the tool's result. They give
 *     us low-latency cards but only carry tool name + input/output, not
 *     surrounding assistant prose.
 *   - JSONL flushes the same events at message-boundary granularity, after
 *     the whole assistant turn or tool call has settled. Slower but
 *     authoritative — includes assistant text, structured ContentBlock
 *     metadata, sidechain flags, etc.
 *
 * Strategy: **first-wins by `tool_use_id`**. Whichever channel reports a
 * tool use / result first gets to emit the CardEvent; the other is dropped.
 * For correctness this requires:
 *   1. Hooks and JSONL agree on the same `tool_use_id` (they do — both
 *      come from the same claude turn, the id is the canonical anthropic id).
 *   2. The CardEvent shape we emit from a hook matches what JSONL would have
 *      produced for the same id. Hooks carry `tool_input` and
 *      `tool_response` as raw JSON-ish values; we delegate to the existing
 *      `StreamCardBuilder` methods so card structure stays consistent.
 *
 * Non-goals: We do NOT try to enrich a hook-emitted card with JSONL data
 * that arrives later. The hook-emitted card is good enough for the UI; the
 * JSONL form would only differ in metadata we don't currently surface.
 * If that becomes important, switch to a merge model (track id → ref →
 * patch on second arrival).
 */

import type { CardEvent } from '@sumicom/quicksave-shared';
import type { StreamCardBuilder } from '../cardBuilder.js';

export interface CardSynthOpts {
  cardBuilder: StreamCardBuilder;
  emit: (event: CardEvent) => void;
}

export class CardSynth {
  private readonly cardBuilder: StreamCardBuilder;
  private readonly emit: (event: CardEvent) => void;
  private readonly toolUseSeen = new Set<string>();
  private readonly toolResultSeen = new Set<string>();

  constructor(opts: CardSynthOpts) {
    this.cardBuilder = opts.cardBuilder;
    this.emit = opts.emit;
  }

  /**
   * Record a tool_use event. Idempotent by toolUseId — second caller is
   * silently skipped.
   * @returns true if the card was emitted, false if it was a duplicate.
   */
  emitToolUse(toolUseId: string, toolName: string, toolInput: Record<string, unknown>): boolean {
    if (!toolUseId) return false;
    if (this.toolUseSeen.has(toolUseId)) return false;
    this.toolUseSeen.add(toolUseId);
    this.emit(this.cardBuilder.toolUse(toolName, toolInput, toolUseId));
    return true;
  }

  /**
   * Record a tool_result event. Idempotent by toolUseId — second caller is
   * silently skipped. `cardBuilder.toolResult` returns null when it can't
   * find the matching tool_use card; we treat that as "not yet emittable"
   * and don't mark seen, so a subsequent JSONL flush can succeed once the
   * tool_use is in the builder.
   * @returns true if the card was emitted, false if it was a dup or no
   *   matching tool_use card exists yet.
   */
  emitToolResult(toolUseId: string, content: string, isError: boolean): boolean {
    if (!toolUseId) return false;
    if (this.toolResultSeen.has(toolUseId)) return false;
    const evt = this.cardBuilder.toolResult(toolUseId, content, isError);
    if (!evt) return false;
    this.toolResultSeen.add(toolUseId);
    this.emit(evt);
    return true;
  }

  /** Internal: stringify a `tool_response` payload that arrives from a hook.
   *  Hooks pass the raw tool output as JSON; the card UI wants a string. */
  static stringifyHookToolResponse(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    try { return JSON.stringify(value); } catch { return String(value); }
  }
}
