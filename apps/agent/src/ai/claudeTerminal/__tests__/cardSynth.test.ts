// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import type { CardEvent } from '@sumicom/quicksave-shared';
import { StreamCardBuilder } from '../../cardBuilder.js';
import { CardSynth } from '../cardSynth.js';

describe('CardSynth', () => {
  let cb: StreamCardBuilder;
  let emitted: CardEvent[];
  let synth: CardSynth;

  beforeEach(() => {
    cb = new StreamCardBuilder({ sessionId: 'sid' });
    cb.startNewTurn();
    emitted = [];
    synth = new CardSynth({
      cardBuilder: cb,
      emit: (e) => { emitted.push(e); },
    });
  });

  const toolCallAdds = () => emitted.filter(
    (e) => e.type === 'add' && (e.card.type === 'tool_call'),
  );
  const toolCallUpdates = () => emitted.filter((e) => e.type === 'update');

  it('emits tool_use exactly once across hook + jsonl arrivals', () => {
    const a = synth.emitToolUse('tu_1', 'Bash', { command: 'ls' });
    const b = synth.emitToolUse('tu_1', 'Bash', { command: 'ls' });
    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(toolCallAdds()).toHaveLength(1);
  });

  it('emits tool_result exactly once across PostToolUse + JSONL', () => {
    synth.emitToolUse('tu_1', 'Bash', {});
    const a = synth.emitToolResult('tu_1', 'output', false);
    const b = synth.emitToolResult('tu_1', 'output', false);
    expect(a).toBe(true);
    expect(b).toBe(false);
    // toolResult triggers an update event on the existing tool_call card.
    expect(toolCallUpdates().length).toBeGreaterThanOrEqual(1);
  });

  it('drops a tool_result with unknown tool_use_id and does NOT mark seen', () => {
    // No tool_use has been recorded — cardBuilder.toolResult returns null.
    const a = synth.emitToolResult('tu_unknown', 'output', false);
    expect(a).toBe(false);
    expect(emitted).toHaveLength(0);

    // After the matching tool_use shows up, a retry SHOULD now succeed.
    synth.emitToolUse('tu_unknown', 'Read', {});
    const b = synth.emitToolResult('tu_unknown', 'output', false);
    expect(b).toBe(true);
  });

  it('ignores empty / missing tool_use_id', () => {
    expect(synth.emitToolUse('', 'Bash', {})).toBe(false);
    expect(synth.emitToolResult('', 'x', false)).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it('stringifyHookToolResponse handles strings, objects, null, and undefined', () => {
    expect(CardSynth.stringifyHookToolResponse('hello')).toBe('hello');
    expect(CardSynth.stringifyHookToolResponse({ a: 1 })).toBe('{"a":1}');
    expect(CardSynth.stringifyHookToolResponse(null)).toBe('');
    expect(CardSynth.stringifyHookToolResponse(undefined)).toBe('');
    expect(CardSynth.stringifyHookToolResponse(42)).toBe('42');
  });

  it('distinct tool_use_ids both emit', () => {
    synth.emitToolUse('tu_1', 'Bash', {});
    synth.emitToolUse('tu_2', 'Read', {});
    expect(toolCallAdds()).toHaveLength(2);
  });
});
