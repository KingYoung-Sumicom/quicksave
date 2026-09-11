// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';

import { NativeExecCompletionTracker, nativeCompletionEventId } from '../nativeExecCompletionTracker.js';
import type { ThreadItem } from '../schema/generated/v2/ThreadItem.js';

const THREAD_ID = 'thr_native';
const TURN_ID = 'turn_origin';

describe('NativeExecCompletionTracker', () => {
  it('queues only a registered native command once its origin turn is complete', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_1'));
    expect(tracker.registerProcessHandle(THREAD_ID, TURN_ID, 'reg_1', '4242')).toBe('registered');
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_1'));

    expect(tracker.takeReady(8)).toEqual([expect.objectContaining({
      eventId: nativeCompletionEventId(THREAD_ID, TURN_ID, 'cmd_1'),
      commandExecutionId: 'cmd_1',
      processHandle: '4242',
      status: 'completed',
    })]);
  });

  it('retains a registered terminal result that arrives before final-answer turn completion', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_early'));
    tracker.registerProcessHandle(THREAD_ID, TURN_ID, 'reg_early', '4242');
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_early'));
    expect(tracker.takeReady(8)).toEqual([]);

    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');
    expect(tracker.takeReady(8)).toHaveLength(1);
  });

  it('does not queue unregistered native commands or process-id-only observations', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_unregistered'));
    tracker.observeItemStarted(THREAD_ID, TURN_ID, {
      ...runningCommand('agent_cmd'),
      source: 'agent',
    });
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_unregistered'));
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('agent_cmd'));

    expect(tracker.takeReady(8)).toEqual([]);
  });

  it('matches terminal-before-start ordering only after the later native start and registration', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_reordered'));
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_reordered'));
    expect(tracker.registerProcessHandle(THREAD_ID, TURN_ID, 'reg_1', '4242')).toBe('registered');
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');

    expect(tracker.takeReady(8).map((event) => event.commandExecutionId)).toEqual(['cmd_reordered']);
  });

  it('retains a registration that arrives before its delayed native start event', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    expect(tracker.registerProcessHandle(THREAD_ID, TURN_ID, 'reg_early', '4242')).toBe('pendingCorrelation');
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_delayed'));
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_delayed'));
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');

    expect(tracker.takeReady(8).map((event) => event.commandExecutionId)).toEqual(['cmd_delayed']);
  });

  it('buffers unknown handles but rejects ambiguous, unrelated, and replayed registrations', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_a'));
    tracker.observeItemStarted(THREAD_ID, TURN_ID, { ...runningCommand('cmd_b'), processId: '4242' });
    expect(tracker.registerProcessHandle(THREAD_ID, TURN_ID, 'unknown', 'nope')).toBe('pendingCorrelation');
    expect(tracker.registerProcessHandle(THREAD_ID, TURN_ID, 'ambiguous', '4242')).toBe('ambiguousHandle');
    expect(tracker.registerProcessHandle('thr_other', TURN_ID, 'other', '4242')).toBe('invalidHandle');
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');
    expect(tracker.registerProcessHandle(THREAD_ID, TURN_ID, 'replay', '4242')).toBe('settledTurn');
  });

  it('deduplicates registration and terminal events without treating write-stdin as a new execution', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_1'));
    expect(tracker.registerProcessHandle(THREAD_ID, TURN_ID, 'reg_1', '4242')).toBe('registered');
    expect(tracker.registerProcessHandle(THREAD_ID, TURN_ID, 'reg_1', '4242')).toBe('alreadyRegistered');
    tracker.observeItemStarted(THREAD_ID, TURN_ID, {
      ...runningCommand('stdin_1'),
      source: 'unifiedExecInteraction',
    });
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_1'));
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_1'));
    expect(tracker.takeReady(8)).toHaveLength(1);
    expect(tracker.takeReady(8)).toEqual([]);
  });

  it('suppresses registered work for an interrupted origin turn', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_1'));
    tracker.registerProcessHandle(THREAD_ID, TURN_ID, 'reg_1', '4242');
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'interrupted');
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_1', { status: 'failed', exitCode: 137 }));
    expect(tracker.takeReady(8)).toEqual([]);
  });

  it('reports bounded ready-inbox coverage loss without evicting the first pending event', () => {
    const degraded = vi.fn();
    const tracker = new NativeExecCompletionTracker({
      threadId: THREAD_ID,
      maxReadyCompletions: 1,
      onCoverageDegraded: degraded,
    });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_a'));
    tracker.observeItemStarted(THREAD_ID, TURN_ID, { ...runningCommand('cmd_b'), processId: '4343' });
    tracker.registerProcessHandle(THREAD_ID, TURN_ID, 'reg_a', '4242');
    tracker.registerProcessHandle(THREAD_ID, TURN_ID, 'reg_b', '4343');
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_a'));
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_b', { processId: '4343' }));

    expect(tracker.takeReady(8).map((event) => event.commandExecutionId)).toEqual(['cmd_a']);
    expect(degraded).toHaveBeenCalledWith(expect.stringContaining('inbox is full'));
  });
});

function runningCommand(id: string): ThreadItem {
  return {
    type: 'commandExecution', id, pluginId: null, scriptPath: null,
    command: 'sleep 2', cwd: '/repo', processId: '4242', source: 'unifiedExecStartup',
    status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null,
  };
}

function completedCommand(
  id: string,
  overrides: Partial<Extract<ThreadItem, { type: 'commandExecution' }>> = {},
): ThreadItem {
  return {
    ...runningCommand(id), status: 'completed', aggregatedOutput: 'done\n', exitCode: 0, durationMs: 2_000, ...overrides,
  } as ThreadItem;
}
