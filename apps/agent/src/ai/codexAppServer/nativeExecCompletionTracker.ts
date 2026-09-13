// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ThreadItem } from './schema/generated/v2/ThreadItem.js';
import type { TurnStatus } from './schema/generated/v2/TurnStatus.js';

const DEFAULT_MAX_TRACKED_EXECUTIONS = 128;
const DEFAULT_MAX_READY_COMPLETIONS = 32;
const MAX_REMEMBERED_IDS = 256;
const MAX_PROCESS_HANDLE_LENGTH = 256;

type NativeCommandExecution = Extract<ThreadItem, { type: 'commandExecution' }>;
type NativeTerminalCommandExecution = NativeCommandExecution & { status: 'completed' | 'failed' };
type DeliveryState = 'none' | 'pending' | 'inFlight';

interface TrackedExecution {
  readonly key: string;
  readonly eventId: string;
  readonly threadId: string;
  readonly originTurnId: string;
  readonly itemId: string;
  started: NativeCommandExecution | null;
  terminal: NativeTerminalCommandExecution | null;
  registered: boolean;
  contradictory: boolean;
  deliveryState: DeliveryState;
}

interface PendingRegistration {
  readonly turnId: string;
  readonly processHandle: string;
}

export type NativeCompletionRegistrationResult =
  | 'registered'
  | 'alreadyRegistered'
  | 'pendingCorrelation'
  | 'invalidHandle'
  | 'unknownHandle'
  | 'ambiguousHandle'
  | 'settledTurn';

/** A factual native completion which the agent explicitly registered to receive. */
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
 * Correlates public native command lifecycle items with explicit agent MCP
 * registrations. A process handle is only meaningful inside its root thread,
 * provider generation, and origin turn; callers must never treat it as an OS
 * PID or attach an ambiguous handle to a command.
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
  private readonly observedRegistrationItemIds = new Set<string>();
  private readonly pendingRegistrations = new Map<string, PendingRegistration>();
  private coverageDegraded = false;

  constructor(opts: NativeExecCompletionTrackerOptions) {
    this.threadId = opts.threadId;
    this.maxTrackedExecutions = opts.maxTrackedExecutions ?? DEFAULT_MAX_TRACKED_EXECUTIONS;
    this.maxReadyCompletions = opts.maxReadyCompletions ?? DEFAULT_MAX_READY_COMPLETIONS;
    this.onCoverageDegraded = opts.onCoverageDegraded;
  }

  observeItemStarted(threadId: string, turnId: string, item: ThreadItem): void {
    if (threadId !== this.threadId || !isNativeUnifiedExecStartup(item)) return;
    if (this.settledTurns.has(turnId)) return; // replay after a cold resume

    const record = this.getOrCreate(turnId, item.id);
    if (!record || record.started) return;
    record.started = item;
    if (record.terminal && !sameProcessHandle(item.processId, record.terminal.processId)) {
      record.contradictory = true;
      return;
    }
    this.reconcilePendingRegistrations(turnId);
    this.enqueueIfReady(record);
  }

  observeItemCompleted(threadId: string, turnId: string, item: ThreadItem): void {
    if (threadId !== this.threadId || !isNativeUnifiedExecTerminal(item)) return;
    const record = this.getOrCreate(turnId, item.id);
    if (!record || record.terminal) return;
    record.terminal = item;
    if (record.started && !sameProcessHandle(record.started.processId, item.processId)) {
      record.contradictory = true;
      return;
    }
    this.enqueueIfReady(record);
  }

  /** Register only a unique native startup from the same root turn. */
  registerProcessHandle(
    threadId: string,
    registrationTurnId: string,
    registrationItemId: string,
    processHandle: unknown,
  ): NativeCompletionRegistrationResult {
    if (threadId !== this.threadId || !isOpaqueHandle(processHandle)) return 'invalidHandle';
    if (this.settledTurns.has(registrationTurnId)) return 'settledTurn';
    if (this.observedRegistrationItemIds.has(registrationItemId)) return 'alreadyRegistered';
    rememberBounded(this.observedRegistrationItemIds, registrationItemId, MAX_REMEMBERED_IDS);

    const candidates = this.candidatesForHandle(registrationTurnId, processHandle);
    if (candidates.length === 0) {
      if (this.pendingRegistrations.size >= this.maxTrackedExecutions) {
        this.degradeCoverage('native completion registration buffer is full; a delayed command start cannot be correlated');
        return 'unknownHandle';
      }
      this.pendingRegistrations.set(registrationItemId, {
        turnId: registrationTurnId,
        processHandle,
      });
      return 'pendingCorrelation';
    }
    if (candidates.length !== 1) return 'ambiguousHandle';

    const record = candidates[0]!;
    if (record.registered) return 'alreadyRegistered';
    record.registered = true;
    this.enqueueIfReady(record);
    return 'registered';
  }

  observeTurnCompleted(threadId: string, turnId: string, status: TurnStatus): void {
    if (threadId !== this.threadId) return;
    rememberBounded(this.settledTurns, turnId, status, MAX_REMEMBERED_IDS);

    for (const record of [...this.executions.values()]) {
      if (record.originTurnId !== turnId) continue;
      if (status !== 'completed' || !record.registered || record.contradictory) {
        this.resolve(record);
        continue;
      }
      this.enqueueIfReady(record);
    }
    for (const [itemId, pending] of this.pendingRegistrations) {
      if (pending.turnId === turnId) this.pendingRegistrations.delete(itemId);
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
    this.pendingRegistrations.clear();
  }

  private getOrCreate(turnId: string, itemId: string): TrackedExecution | undefined {
    const key = executionKey(turnId, itemId);
    const existing = this.executions.get(key);
    if (existing) return existing;
    if (this.executions.size >= this.maxTrackedExecutions) {
      this.degradeCoverage('native execution tracker is full; new registered command completions cannot be delivered');
      return undefined;
    }
    const record: TrackedExecution = {
      key,
      eventId: nativeCompletionEventId(this.threadId, turnId, itemId),
      threadId: this.threadId,
      originTurnId: turnId,
      itemId,
      started: null,
      terminal: null,
      registered: false,
      contradictory: false,
      deliveryState: 'none',
    };
    this.executions.set(key, record);
    return record;
  }

  private enqueueIfReady(record: TrackedExecution): void {
    if (
      !record.registered
      || !record.started
      || !record.terminal
      || record.contradictory
      || this.settledTurns.get(record.originTurnId) !== 'completed'
      || record.deliveryState !== 'none'
      || this.resolvedEventIds.has(record.eventId)
    ) return;
    if (this.readyKeys.length >= this.maxReadyCompletions) {
      this.degradeCoverage('native completion inbox is full; a registered completion could not be delivered');
      this.resolve(record);
      return;
    }
    record.deliveryState = 'pending';
    this.readyKeys.push(record.key);
  }

  private candidatesForHandle(turnId: string, processHandle: string): TrackedExecution[] {
    return [...this.executions.values()].filter((record) =>
      record.originTurnId === turnId
      && record.started !== null
      && record.started.processId === processHandle
      && !record.contradictory
      && !this.resolvedEventIds.has(record.eventId),
    );
  }

  private reconcilePendingRegistrations(turnId: string): void {
    for (const [itemId, pending] of this.pendingRegistrations) {
      if (pending.turnId !== turnId) continue;
      const candidates = this.candidatesForHandle(turnId, pending.processHandle);
      if (candidates.length === 0) continue;
      this.pendingRegistrations.delete(itemId);
      if (candidates.length !== 1) continue;
      const record = candidates[0]!;
      record.registered = true;
      this.enqueueIfReady(record);
    }
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

function isOpaqueHandle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PROCESS_HANDLE_LENGTH;
}

function sameProcessHandle(left: string | null, right: string | null): boolean {
  return left === null || right === null || left === right;
}

function executionKey(turnId: string, itemId: string): string {
  return `${turnId}\u0000${itemId}`;
}

export function nativeCompletionEventId(threadId: string, turnId: string, itemId: string): string {
  return `quicksave-native-exec:v1:${threadId}:${turnId}:${itemId}`;
}

function toReadyCompletion(record: TrackedExecution, item: NativeTerminalCommandExecution): ReadyNativeExecCompletion {
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
function rememberBounded<T>(target: Set<T> | Map<T, unknown>, key: T, valueOrMax: unknown, maybeMax?: number): void {
  const max = maybeMax ?? valueOrMax as number;
  if (target instanceof Map) target.set(key, valueOrMax);
  else target.add(key);
  while (target.size > max) {
    const oldest = target.keys().next().value;
    if (oldest === undefined) return;
    target.delete(oldest);
  }
}
