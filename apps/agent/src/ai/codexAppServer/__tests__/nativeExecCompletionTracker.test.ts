// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';

import { NativeExecCompletionTracker, nativeCompletionEventId } from '../nativeExecCompletionTracker.js';
import type { ThreadItem } from '../schema/generated/v2/ThreadItem.js';

const THREAD_ID = 'thr_native';
const TURN_ID = 'turn_origin';

describe('NativeExecCompletionTracker', () => {
  it('queues a native unified-exec completion only when its terminal item follows turn completion', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_1'));
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_1'));

    expect(tracker.takeReady(8)).toEqual([expect.objectContaining({
      eventId: nativeCompletionEventId(THREAD_ID, TURN_ID, 'cmd_1'),
      originTurnId: TURN_ID,
      commandExecutionId: 'cmd_1',
      processHandle: '4242',
      status: 'completed',
      exitCode: 0,
    })]);
  });

  it('does not queue a command that completed while the originating turn was still active', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_1'));
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_1'));
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');

    expect(tracker.takeReady(8)).toEqual([]);
  });

  it('does not classify processId alone, agent commands, or interactive polls as native startup executions', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, {
      ...runningCommand('agent_cmd'),
      source: 'agent',
    });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, {
      ...runningCommand('stdin_cmd'),
      source: 'unifiedExecInteraction',
    });
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('agent_cmd'));
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('stdin_cmd'));

    expect(tracker.takeReady(8)).toEqual([]);
  });

  it('deduplicates repeated lifecycle events and preserves concurrent command identity', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_a'));
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_b'));
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_a'));
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_b', { command: 'sleep 2' }));
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_a', { command: 'sleep 2' }));
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_a', { command: 'sleep 2' }));

    expect(tracker.takeReady(8).map((event) => event.commandExecutionId)).toEqual(['cmd_b', 'cmd_a']);
    expect(tracker.takeReady(8)).toEqual([]);
  });

  it('rejects unrelated threads and start events replayed after the turn settled', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemStarted('thr_other', TURN_ID, runningCommand('other'));
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('replayed'));
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('replayed'));

    expect(tracker.takeReady(8)).toEqual([]);
  });

  it('suppresses interrupted and failed origin turns without mistaking a failed command for cancellation', () => {
    const tracker = new NativeExecCompletionTracker({ threadId: THREAD_ID });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_1'));
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'interrupted');
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_1', {
      status: 'failed',
      exitCode: 137,
    }));

    expect(tracker.takeReady(8)).toEqual([]);
  });

  it('does not silently evict a pending completion when its inbox bound is reached', () => {
    const degraded = vi.fn();
    const tracker = new NativeExecCompletionTracker({
      threadId: THREAD_ID,
      maxReadyCompletions: 1,
      onCoverageDegraded: degraded,
    });
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_1'));
    tracker.observeItemStarted(THREAD_ID, TURN_ID, runningCommand('cmd_2'));
    tracker.observeTurnCompleted(THREAD_ID, TURN_ID, 'completed');
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_1'));
    tracker.observeItemCompleted(THREAD_ID, TURN_ID, completedCommand('cmd_2'));

    expect(tracker.takeReady(8).map((event) => event.commandExecutionId)).toEqual(['cmd_1']);
    expect(degraded).toHaveBeenCalledWith(expect.stringContaining('inbox is full'));
  });
});

function runningCommand(id: string): ThreadItem {
  return {
    type: 'commandExecution',
    id,
    pluginId: null,
    scriptPath: null,
    command: 'sleep 2',
    cwd: '/repo',
    processId: '4242',
    source: 'unifiedExecStartup',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
}

function completedCommand(
  id: string,
  overrides: Partial<Extract<ThreadItem, { type: 'commandExecution' }>> = {},
): ThreadItem {
  return {
    ...runningCommand(id),
    status: 'completed',
    aggregatedOutput: 'done\n',
    exitCode: 0,
    durationMs: 2000,
    ...overrides,
  } as ThreadItem;
}
