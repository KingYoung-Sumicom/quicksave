// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  normalizeAgentId,
  codexModelsToOptions,
  formatCodexModelLabel,
  CLAUDE_MODELS,
  modelSupports1m,
  getContextWindowOptionsForModel,
  clampContextWindowForModel,
  getModelContextLimit,
} from './claudePresets';

describe('claudePresets', () => {
  describe('normalizeAgentId', () => {
    it('returns codex for "codex"', () => {
      expect(normalizeAgentId('codex')).toBe('codex');
    });

    it('returns codex for legacy "codex-mcp"', () => {
      expect(normalizeAgentId('codex-mcp')).toBe('codex');
    });

    it('returns claude-code for "claude-code"', () => {
      expect(normalizeAgentId('claude-code')).toBe('claude-code');
    });

    it('returns claude-code for undefined', () => {
      expect(normalizeAgentId(undefined)).toBe('claude-code');
    });

    it('returns claude-code for any unknown string', () => {
      expect(normalizeAgentId('something-else')).toBe('claude-code');
    });
  });

  describe('codexModelsToOptions', () => {
    it('converts CodexModelInfo to options format', () => {
      const result = codexModelsToOptions([
        { id: 'o4-mini', name: 'o4-mini' },
        { id: 'o3', name: 'o3' },
      ]);
      expect(result).toEqual([
        { value: 'o4-mini', label: 'o4-mini' },
        { value: 'o3', label: 'o3' },
      ]);
    });

    it('formats known Codex ids when app-server returns the raw id as name', () => {
      const result = codexModelsToOptions([
        { id: 'gpt-5.3-codex', name: 'gpt-5.3-codex' },
        { id: 'gpt-5.2', name: 'gpt-5.2' },
      ]);
      expect(result).toEqual([
        { value: 'gpt-5.3-codex', label: 'GPT-5.3-Codex' },
        { value: 'gpt-5.2', label: 'GPT-5.2' },
      ]);
    });

    it('preserves custom app-server display names for unknown models', () => {
      expect(formatCodexModelLabel('custom-model', 'Custom Model')).toBe('Custom Model');
    });

    it('handles empty array', () => {
      expect(codexModelsToOptions([])).toEqual([]);
    });
  });

  describe('CLAUDE_MODELS', () => {
    it('drops the legacy [1m] suffix from preset values', () => {
      // Context window is now a separate axis — the suffix is appended on
      // the agent side at spawn time, not embedded in the picker option.
      for (const m of CLAUDE_MODELS) {
        expect(m.value).not.toMatch(/\[1m\]/i);
      }
    });
  });

  describe('modelSupports1m', () => {
    it('returns false for haiku regardless of allowBilled', () => {
      expect(modelSupports1m('claude-haiku-4-5-20251001')).toBe(false);
      expect(modelSupports1m('claude-haiku-4-5-20251001', { allowBilled: true })).toBe(false);
    });

    it('returns false for sonnet without allowBilled (1M needs usage credits)', () => {
      expect(modelSupports1m('claude-sonnet-4-6')).toBe(false);
    });

    it('returns true for sonnet only when allowBilled is opted in', () => {
      expect(modelSupports1m('claude-sonnet-4-6', { allowBilled: true })).toBe(true);
    });

    it('returns true for opus regardless of allowBilled (1M included in subscriptions)', () => {
      expect(modelSupports1m('claude-opus-4-7')).toBe(true);
      expect(modelSupports1m('claude-opus-4-7', { allowBilled: false })).toBe(true);
    });
  });

  describe('getContextWindowOptionsForModel', () => {
    it('returns only 200k for haiku', () => {
      const opts = getContextWindowOptionsForModel('claude-haiku-4-5-20251001');
      expect(opts.map((o) => o.value)).toEqual([200_000]);
    });

    it('returns only 200k for sonnet by default', () => {
      const opts = getContextWindowOptionsForModel('claude-sonnet-4-6');
      expect(opts.map((o) => o.value)).toEqual([200_000]);
    });

    it('returns the full ladder for sonnet when allowBilled is on', () => {
      const opts = getContextWindowOptionsForModel('claude-sonnet-4-6', { allowBilled: true });
      expect(opts.map((o) => o.value)).toEqual([200_000, 500_000, 1_000_000]);
    });

    it('returns 200k/500k/1M for opus without allowBilled', () => {
      const opts = getContextWindowOptionsForModel('claude-opus-4-7');
      expect(opts.map((o) => o.value)).toEqual([200_000, 500_000, 1_000_000]);
    });

    it('returns only 200k when model is undefined', () => {
      const opts = getContextWindowOptionsForModel(undefined);
      expect(opts.map((o) => o.value)).toEqual([200_000]);
    });
  });

  describe('clampContextWindowForModel', () => {
    it('clamps haiku down to 200k regardless of input', () => {
      expect(clampContextWindowForModel('claude-haiku-4-5-20251001', 1_000_000)).toBe(200_000);
    });

    it('clamps sonnet down to 200k when allowBilled is off (default)', () => {
      expect(clampContextWindowForModel('claude-sonnet-4-6', 1_000_000)).toBe(200_000);
    });

    it('preserves 1M on sonnet when allowBilled is on', () => {
      expect(clampContextWindowForModel('claude-sonnet-4-6', 1_000_000, { allowBilled: true }))
        .toBe(1_000_000);
    });

    it('passes 1M through for opus regardless of allowBilled', () => {
      expect(clampContextWindowForModel('claude-opus-4-7', 1_000_000)).toBe(1_000_000);
    });

    it('falls back to default 200k when both inputs are missing', () => {
      expect(clampContextWindowForModel(undefined, undefined)).toBe(200_000);
    });
  });

  describe('getModelContextLimit', () => {
    it('prefers session-scoped contextWindow when present', () => {
      // The badge needs to show /500k for a Sonnet session set to 500k —
      // the model alone would otherwise resolve to 200k.
      expect(getModelContextLimit('claude-sonnet-4-6', undefined, 500_000)).toBe(500_000);
    });

    it('falls back to legacy [1m] suffix when no session value is given', () => {
      expect(getModelContextLimit('claude-opus-4-7[1m]')).toBe(1_000_000);
    });

    it('defaults to 200k for an unrecognized claude model', () => {
      expect(getModelContextLimit('claude-sonnet-4-6')).toBe(200_000);
    });

    it('reads codex contextWindow from the dynamic list', () => {
      const dynamic = [{ id: 'gpt-5', name: 'GPT-5', contextWindow: 400_000 }];
      expect(getModelContextLimit('gpt-5', dynamic)).toBe(400_000);
    });

    it('falls back to Codex 400k for GPT-5.5 before runtime usage arrives', () => {
      expect(getModelContextLimit('gpt-5.5')).toBe(400_000);
    });
  });
});
