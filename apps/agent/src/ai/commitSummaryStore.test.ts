import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommitSummaryStateStore } from './commitSummaryStore.js';
import type { CommitSummaryState } from '@sumicom/quicksave-shared';

describe('CommitSummaryStateStore', () => {
  let store: CommitSummaryStateStore;
  let events: CommitSummaryState[];

  beforeEach(() => {
    store = new CommitSummaryStateStore();
    events = [];
    store.on('state-updated', (s) => events.push(s));
  });

  describe('get', () => {
    it('returns an idle state for an unknown repo', () => {
      const s = store.get('/r');
      expect(s).toEqual({ repoPath: '/r', status: 'idle' });
    });

    it('returns stored state after a write', () => {
      store.startGenerating('/r', 'manual', 'claude-sonnet-4-6', () => {});
      expect(store.get('/r').status).toBe('generating');
    });
  });

  describe('startGenerating', () => {
    it('writes a generating state with a preparing progress frame', () => {
      const token = store.startGenerating('/r', 'manual', 'claude-sonnet-4-6', () => {});
      expect(typeof token).toBe('symbol');
      const state = store.get('/r');
      expect(state.status).toBe('generating');
      expect(state.repoPath).toBe('/r');
      expect(state.source).toBe('manual');
      expect(state.model).toBe('claude-sonnet-4-6');
      expect(state.startedAt).toBeGreaterThan(0);
      expect(state.progress?.phase).toBe('preparing');
      expect(events).toHaveLength(1);
    });

    it('aborts any prior active generation for the same repo', () => {
      const abortA = vi.fn();
      const abortB = vi.fn();
      store.startGenerating('/r', 'manual', undefined, abortA);
      store.startGenerating('/r', 'manual', undefined, abortB);
      expect(abortA).toHaveBeenCalledTimes(1);
      expect(abortB).not.toHaveBeenCalled();
    });

    it('does not cross-abort between different repos', () => {
      const abortA = vi.fn();
      const abortB = vi.fn();
      store.startGenerating('/r1', 'manual', undefined, abortA);
      store.startGenerating('/r2', 'manual', undefined, abortB);
      expect(abortA).not.toHaveBeenCalled();
      expect(abortB).not.toHaveBeenCalled();
    });

    it('swallows errors thrown by the prior abort callback', () => {
      const abortA = vi.fn(() => { throw new Error('boom'); });
      store.startGenerating('/r', 'manual', undefined, abortA);
      expect(() => store.startGenerating('/r', 'manual', undefined, () => {})).not.toThrow();
    });
  });

  describe('isGenerating / activeToken', () => {
    it('reports active status and token', () => {
      const t = store.startGenerating('/r', 'manual', undefined, () => {});
      expect(store.isGenerating('/r')).toBe(true);
      expect(store.activeToken('/r')).toBe(t);
    });

    it('clears active token after setResult', () => {
      const t = store.startGenerating('/r', 'manual', undefined, () => {});
      store.setResult('/r', t, { summary: 'feat: x' });
      expect(store.isGenerating('/r')).toBe(false);
      expect(store.activeToken('/r')).toBeUndefined();
    });

    it('clears active token after setError', () => {
      const t = store.startGenerating('/r', 'manual', undefined, () => {});
      store.setError('/r', t, 'nope', 'CLI_ERROR');
      expect(store.isGenerating('/r')).toBe(false);
      expect(store.activeToken('/r')).toBeUndefined();
    });
  });

  describe('updateProgress', () => {
    it('merges progress fields and computes elapsedMs', async () => {
      const t = store.startGenerating('/r', 'manual', undefined, () => {});
      await new Promise((r) => setTimeout(r, 5));
      store.updateProgress('/r', t, { phase: 'inspecting', toolCount: 3, lastToolName: 'Grep' });
      const state = store.get('/r');
      expect(state.progress?.phase).toBe('inspecting');
      expect(state.progress?.toolCount).toBe(3);
      expect(state.progress?.lastToolName).toBe('Grep');
      expect(state.progress?.elapsedMs).toBeGreaterThan(0);
    });

    it('ignores writes from a stale token', () => {
      const staleToken = Symbol('stale');
      store.startGenerating('/r', 'manual', undefined, () => {});
      const beforeCount = events.length;
      store.updateProgress('/r', staleToken, { phase: 'inspecting' });
      expect(events.length).toBe(beforeCount);
    });

    it('ignores writes after the state is no longer generating', () => {
      const t = store.startGenerating('/r', 'manual', undefined, () => {});
      store.setResult('/r', t, { summary: 'feat: x' });
      const beforeCount = events.length;
      store.updateProgress('/r', t, { phase: 'finalizing' });
      expect(events.length).toBe(beforeCount);
    });

    it('preserves previous progress fields when the update omits them', () => {
      const t = store.startGenerating('/r', 'manual', undefined, () => {});
      store.updateProgress('/r', t, { phase: 'inspecting', toolCount: 2, lastToolName: 'Read' });
      store.updateProgress('/r', t, { partialText: 'thinking...' });
      const state = store.get('/r');
      expect(state.progress?.phase).toBe('inspecting');
      expect(state.progress?.toolCount).toBe(2);
      expect(state.progress?.lastToolName).toBe('Read');
      expect(state.progress?.partialText).toBe('thinking...');
    });
  });

  describe('setResult', () => {
    it('writes ready state with summary + description + usage', () => {
      const t = store.startGenerating('/r', 'manual', 'claude-sonnet-4-6', () => {});
      store.setResult('/r', t, {
        summary: 'feat: add thing',
        description: 'body',
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        cached: false,
      });
      const state = store.get('/r');
      expect(state.status).toBe('ready');
      expect(state.summary).toBe('feat: add thing');
      expect(state.description).toBe('body');
      expect(state.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
      expect(state.completedAt).toBeGreaterThan(0);
      expect(state.source).toBe('manual'); // preserved from generating state
      expect(state.model).toBe('claude-sonnet-4-6');
    });

    it('ignores a stale token', () => {
      store.startGenerating('/r', 'manual', undefined, () => {});
      const stale = Symbol('stale');
      const beforeCount = events.length;
      store.setResult('/r', stale, { summary: 'x' });
      expect(events.length).toBe(beforeCount);
      expect(store.get('/r').status).toBe('generating');
    });
  });

  describe('setError', () => {
    it('writes error state and clears active token', () => {
      const t = store.startGenerating('/r', 'manual', undefined, () => {});
      store.setError('/r', t, 'timed out', 'CLI_TIMEOUT');
      const state = store.get('/r');
      expect(state.status).toBe('error');
      expect(state.error).toBe('timed out');
      expect(state.errorCode).toBe('CLI_TIMEOUT');
      expect(store.activeToken('/r')).toBeUndefined();
    });

    it('ignores stale token', () => {
      store.startGenerating('/r', 'manual', undefined, () => {});
      const stale = Symbol('stale');
      store.setError('/r', stale, 'no', 'CLI_ERROR');
      expect(store.get('/r').status).toBe('generating');
    });
  });

  describe('clear', () => {
    it('aborts active generation and resets to idle', () => {
      const abort = vi.fn();
      store.startGenerating('/r', 'manual', undefined, abort);
      const next = store.clear('/r');
      expect(abort).toHaveBeenCalledTimes(1);
      expect(next).toEqual({ repoPath: '/r', status: 'idle' });
      expect(store.isGenerating('/r')).toBe(false);
    });

    it('emits state-updated with the idle state', () => {
      store.startGenerating('/r', 'manual', undefined, () => {});
      events.length = 0;
      store.clear('/r');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ repoPath: '/r', status: 'idle' });
    });

    it('works on a repo with no active generation', () => {
      const next = store.clear('/r');
      expect(next.status).toBe('idle');
      expect(events.at(-1)?.status).toBe('idle');
    });
  });

  describe('snapshot', () => {
    it('returns every tracked repo state', () => {
      store.startGenerating('/r1', 'manual', undefined, () => {});
      store.startGenerating('/r2', 'manual', undefined, () => {});
      const snap = store.snapshot();
      expect(snap.map((s) => s.repoPath).sort()).toEqual(['/r1', '/r2']);
    });

    it('returns an empty array before any writes', () => {
      expect(store.snapshot()).toEqual([]);
    });
  });
});
