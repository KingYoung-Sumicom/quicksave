// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ThreadItem } from './schema/generated/v2/ThreadItem.js';
import type { TurnStatus } from './schema/generated/v2/TurnStatus.js';

const DEFAULT_MAX_TRACKED_EXECUTIONS = 128;
const DEFAULT_MAX_READY_COMPLETIONS = 32;
const MAX_REMEMBERED_IDS = 256;

type NativeCommandExecution = Extract<ThreadItem, { type: 'commandExecution' }>;
type NativeTerminalCommandExecution = NativeCommandExecution & { status: 'completed' | 'failed' };

type DeliveryState = 'none' | 'pending' | 'inFlight';

interface TrackedExecution {
  readonly key: string;
  readonly eventId: string;
  readonly threadId: string;
  readonly originTurnId: string;
  readonly itemId: string;
  terminal: NativeTerminalCommandExecution | null;
  deliveryState: DeliveryState;
}

/**
 * A completion that is safe to present to Codex as a new host-originated tool
 * output. This deliberately has a narrower contract than “background process
 * detected”: it is a native unified-exec command whose terminal item arrived
 * after its owning turn had already completed.
 */
export interface ReadyNativeExecCompletion {
  readonly eventId: string;
  readonly threadId: string;
  readonly originTurnId: string;
  readonly commandExecutionId: string;
  readonly command: string;
  readonly cwd: string;
  /** Opaque Codex execution handle, never an OS PID. */
  readonly processHandle: string | null;
  readonly status: 'completed' | 'failed';
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly aggregatedOutput: string | null;
}

export interface NativeExecCompletionTrackerOptions {
  readonly threadId: string;
  readonly maxTrackedExecutions?: number;
  readonly maxReadyCompletions?: number;
  /** Called once when a bound prevents reliable coverage of a new execution. */
  readonly onCoverageDegraded?: (reason: string) => void;
}

/**
 * Correlates only public `commandExecution` lifecycle items. We intentionally
 * do not infer a running handle from elapsed time, `processId`, or a turn
 * phase; those signals are insufficient to prove native backgrounding.
 */
export class NativeExecCompletionTracker {
  private readonly threadId: string;
  private readonly maxTrackedExecutions: number;
  private readonly maxReadyCompletions: number;
  private readonly onCoverageDegraded: ((reason: string) => void) | undefined;
  private readonly executions = new Map<string, TrackedExecution>();
  private readonly settledTurns = new Map<string, TurnStatus>();
  private readonly readyKeys: string[] = [];
  private readonly resolvedEventIds = new Set<string>();
  private coverageDegraded = false;

  constructor(opts: NativeExecCompletionTrackerOptions) {
    this.threadId = opts.threadId;
    this.maxTrackedExecutions = opts.maxTrackedExecutions ?? DEFAULT_MAX_TRACKED_EXECUTIONS;
    this.maxReadyCompletions = opts.maxReadyCompletions ?? DEFAULT_MAX_READY_COMPLETIONS;
    this.onCoverageDegraded = opts.onCoverageDegraded;
  }

  observeItemStarted(threadId: string, turnId: string, item: ThreadItem): void {
    if (threadId !== this.threadId || !isNativeUnifiedExecStartup(item)) return;
    // A lifecycle start received after the origin turn was already settled is
    // replay/out-of-order data, not evidence for a newly live execution.
    if (this.settledTurns.has(turnId)) return;

    const key = executionKey(turnId, item.id);
    if (this.executions.has(key)) return;
    if (this.executions.size >= this.maxTrackedExecutions) {
      this.degradeCoverage('native execution tracker is full; new command completions will not auto-continue');
      return;
    }

    this.executions.set(key, {
      key,
      eventId: nativeCompletionEventId(this.threadId, turnId, item.id),
      threadId,
      originTurnId: turnId,
      itemId: item.id,
      terminal: null,
      deliveryState: 'none',
    });
  }

  observeItemCompleted(threadId: string, turnId: string, item: ThreadItem): void {
    if (threadId !== this.threadId || !isNativeUnifiedExecTerminal(item)) return;
    const record = this.executions.get(executionKey(turnId, item.id));
    if (!record || record.terminal) return;

    record.terminal = item;
    const turnStatus = this.settledTurns.get(turnId);
    if (turnStatus === undefined) return;
    if (turnStatus !== 'completed') {
      this.resolve(record);
      return;
    }
    this.enqueueIfReady(record);
  }

  observeTurnCompleted(threadId: string, turnId: string, status: TurnStatus): void {
    if (threadId !== this.threadId) return;
    rememberBounded(this.settledTurns, turnId, status, MAX_REMEMBERED_IDS);

    for (const record of [...this.executions.values()]) {
      if (record.originTurnId !== turnId) continue;
      // A terminal item that preceded the turn boundary was already consumed by
      // the originating model turn. It must never re-arm a follow-up turn.
      if (record.terminal) {
        this.resolve(record);
      }
    }
  }

  /** Mark the supplied events as accepted by app-server, not merely queued. */
  markAccepted(eventIds: readonly string[]): void {
    this.resolveByEventIds(eventIds);
  }

  markSuppressed(eventIds: readonly string[]): void {
    this.resolveByEventIds(eventIds);
  }

  /** A definitive app-server rejection can be retried once the scheduler is idle. */
  requeue(eventIds: readonly string[]): void {
    for (const eventId of eventIds) {
      const record = this.findByEventId(eventId);
      if (!record || record.deliveryState !== 'inFlight' || !record.terminal) continue;
      record.deliveryState = 'pending';
      this.readyKeys.push(record.key);
    }
  }

  takeReady(limit: number): ReadyNativeExecCompletion[] {
    const out: ReadyNativeExecCompletion[] = [];
    while (out.length < limit && this.readyKeys.length > 0) {
      const key = this.readyKeys.shift()!;
      const record = this.executions.get(key);
      if (!record || record.deliveryState !== 'pending' || !record.terminal) continue;
      record.deliveryState = 'inFlight';
      out.push(toReadyCompletion(record, record.terminal));
    }
    return out;
  }

  suppressAll(): void {
    for (const record of [...this.executions.values()]) this.resolve(record);
    this.readyKeys.length = 0;
  }

  clear(): void {
    this.executions.clear();
    this.settledTurns.clear();
    this.readyKeys.length = 0;
    this.resolvedEventIds.clear();
  }

  private enqueueIfReady(record: TrackedExecution): void {
    if (record.deliveryState !== 'none' || this.resolvedEventIds.has(record.eventId)) return;
    if (this.readyKeys.length >= this.maxReadyCompletions) {
      this.degradeCoverage('native completion inbox is full; completion delivery is suppressed until user activity');
      this.resolve(record);
      return;
    }
    record.deliveryState = 'pending';
    this.readyKeys.push(record.key);
  }

  private resolveByEventIds(eventIds: readonly string[]): void {
    for (const eventId of eventIds) {
      const record = this.findByEventId(eventId);
      if (record) this.resolve(record);
      else rememberBounded(this.resolvedEventIds, eventId, MAX_REMEMBERED_IDS);
    }
  }

  private resolve(record: TrackedExecution): void {
    this.executions.delete(record.key);
    rememberBounded(this.resolvedEventIds, record.eventId, MAX_REMEMBERED_IDS);
  }

  private findByEventId(eventId: string): TrackedExecution | undefined {
    for (const record of this.executions.values()) {
      if (record.eventId === eventId) return record;
    }
    return undefined;
  }

  private degradeCoverage(reason: string): void {
    if (this.coverageDegraded) return;
    this.coverageDegraded = true;
    this.onCoverageDegraded?.(reason);
  }
}

function isNativeUnifiedExecStartup(item: ThreadItem): item is NativeCommandExecution {
  return item.type === 'commandExecution'
    && item.source === 'unifiedExecStartup'
    && item.status === 'inProgress';
}

function isNativeUnifiedExecTerminal(item: ThreadItem): item is NativeTerminalCommandExecution {
  return item.type === 'commandExecution'
    && item.source === 'unifiedExecStartup'
    && (item.status === 'completed' || item.status === 'failed');
}

function executionKey(turnId: string, itemId: string): string {
  return `${turnId}\u0000${itemId}`;
}

export function nativeCompletionEventId(threadId: string, turnId: string, itemId: string): string {
  return `quicksave-native-exec:v1:${threadId}:${turnId}:${itemId}`;
}

function toReadyCompletion(
  record: TrackedExecution,
  item: NativeTerminalCommandExecution,
): ReadyNativeExecCompletion {
  return {
    eventId: record.eventId,
    threadId: record.threadId,
    originTurnId: record.originTurnId,
    commandExecutionId: record.itemId,
    command: item.command,
    cwd: item.cwd,
    processHandle: item.processId,
    status: item.status,
    exitCode: item.exitCode,
    durationMs: item.durationMs,
    aggregatedOutput: item.aggregatedOutput,
  };
}

function rememberBounded<T>(set: Set<T>, value: T, max: number): void;
function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void;
function rememberBounded<T>(
  target: Set<T> | Map<T, unknown>,
  key: T,
  valueOrMax: unknown,
  maybeMax?: number,
): void {
  const max = maybeMax ?? valueOrMax as number;
  if (target instanceof Map) {
    target.set(key, valueOrMax);
  } else {
    target.add(key);
  }
  while (target.size > max) {
    const oldest = target.keys().next().value;
    if (oldest === undefined) return;
    target.delete(oldest);
  }
}
