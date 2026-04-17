/**
 * CommitSummaryStateStore — agent-owned per-repo state for AI commit summary
 * generation.
 *
 * The state lives on the agent (not the PWA) so that:
 *   • Long-running agentic generations (Claude CLI can take ~2 minutes) survive
 *     PWA reloads and reconnections.
 *   • Multiple PWAs/tabs see the same pending suggestion and can apply or
 *     dismiss it cooperatively.
 *
 * State is keyed by repoPath. Emits `state-updated` (full state snapshot) any
 * time a state mutation happens — the daemon wires this to `connection.broadcast`
 * so all connected peers observe the change.
 */

import { EventEmitter } from 'events';
import type {
  CommitSummaryProgress,
  CommitSummaryState,
  CommitSummaryStatus,
  CommitSummarySource,
  ClaudeModel,
  TokenUsage,
  GenerateCommitSummaryErrorCode,
} from '@sumicom/quicksave-shared';

interface ActiveGeneration {
  abort: () => void;
  token: symbol;
}

export interface CommitSummaryStoreEvents {
  'state-updated': (state: CommitSummaryState) => void;
}

export declare interface CommitSummaryStateStore {
  on<E extends keyof CommitSummaryStoreEvents>(event: E, listener: CommitSummaryStoreEvents[E]): this;
  emit<E extends keyof CommitSummaryStoreEvents>(event: E, ...args: Parameters<CommitSummaryStoreEvents[E]>): boolean;
}

export class CommitSummaryStateStore extends EventEmitter {
  private states = new Map<string, CommitSummaryState>();
  private active = new Map<string, ActiveGeneration>();

  get(repoPath: string): CommitSummaryState {
    return this.states.get(repoPath) ?? idleState(repoPath);
  }

  /** Is a generation currently in flight for this repo? */
  isGenerating(repoPath: string): boolean {
    return this.states.get(repoPath)?.status === 'generating';
  }

  /** Returns the abort token for the active generation, if any. The caller
   *  can use this token later to ensure they're not clobbering a newer run. */
  activeToken(repoPath: string): symbol | undefined {
    return this.active.get(repoPath)?.token;
  }

  /**
   * Mark generation as started and register an abort callback. Returns the
   * opaque token that services can check before writing results — if the
   * token no longer matches, a newer kickoff has superseded this one.
   */
  startGenerating(
    repoPath: string,
    source: CommitSummarySource,
    model: ClaudeModel | undefined,
    onAbort: () => void,
  ): symbol {
    // Abort any prior active generation for the same repo
    const prev = this.active.get(repoPath);
    if (prev) {
      try { prev.abort(); } catch { /* ignore */ }
    }

    const token = Symbol(`commit-summary:${repoPath}`);
    this.active.set(repoPath, { abort: onAbort, token });

    const next: CommitSummaryState = {
      repoPath,
      status: 'generating',
      startedAt: Date.now(),
      source,
      model,
      progress: { phase: 'preparing', elapsedMs: 0 },
    };
    this.writeState(next);
    return token;
  }

  updateProgress(repoPath: string, token: symbol, progress: Partial<CommitSummaryProgress>): void {
    if (this.active.get(repoPath)?.token !== token) return; // stale
    const prev = this.states.get(repoPath);
    if (!prev || prev.status !== 'generating') return;

    const elapsedMs = prev.startedAt ? Date.now() - prev.startedAt : undefined;
    const merged: CommitSummaryProgress = {
      phase: progress.phase ?? prev.progress?.phase ?? 'generating',
      elapsedMs,
      toolCount: progress.toolCount ?? prev.progress?.toolCount,
      lastToolName: progress.lastToolName ?? prev.progress?.lastToolName,
      partialText: progress.partialText ?? prev.progress?.partialText,
    };
    this.writeState({ ...prev, progress: merged });
  }

  setResult(
    repoPath: string,
    token: symbol,
    result: {
      summary: string;
      description?: string;
      tokenUsage?: TokenUsage;
      cached?: boolean;
    },
  ): void {
    if (this.active.get(repoPath)?.token !== token) return; // stale
    this.active.delete(repoPath);
    const prev = this.states.get(repoPath);
    const next: CommitSummaryState = {
      repoPath,
      status: 'ready',
      startedAt: prev?.startedAt,
      completedAt: Date.now(),
      source: prev?.source,
      model: prev?.model,
      summary: result.summary,
      description: result.description,
      tokenUsage: result.tokenUsage,
      cached: result.cached,
    };
    this.writeState(next);
  }

  setError(
    repoPath: string,
    token: symbol,
    error: string,
    errorCode?: GenerateCommitSummaryErrorCode,
  ): void {
    if (this.active.get(repoPath)?.token !== token) return; // stale
    this.active.delete(repoPath);
    const prev = this.states.get(repoPath);
    const next: CommitSummaryState = {
      repoPath,
      status: 'error',
      startedAt: prev?.startedAt,
      completedAt: Date.now(),
      source: prev?.source,
      model: prev?.model,
      error,
      errorCode,
    };
    this.writeState(next);
  }

  /** Reset the state to idle. If a generation is in-flight, abort it first. */
  clear(repoPath: string): CommitSummaryState {
    const active = this.active.get(repoPath);
    if (active) {
      try { active.abort(); } catch { /* ignore */ }
      this.active.delete(repoPath);
    }
    const next = idleState(repoPath);
    this.writeState(next);
    return next;
  }

  /** Snapshot every tracked repo state (debugging / introspection). */
  snapshot(): CommitSummaryState[] {
    return Array.from(this.states.values());
  }

  private writeState(state: CommitSummaryState): void {
    this.states.set(state.repoPath, state);
    this.emit('state-updated', state);
  }
}

function idleState(repoPath: string): CommitSummaryState {
  return { repoPath, status: 'idle' satisfies CommitSummaryStatus };
}
