// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  getAgentType,
  normalizeAgentId,
  getModelsForAgent,
  codexModelsToOptions,
  CLAUDE_MODELS,
  CODEX_MODELS_FALLBACK,
  AGENT_TYPES,
  modelSupports1m,
  getContextWindowOptionsForModel,
  clampContextWindowForModel,
  getModelContextLimit,
} from './claudePresets';

describe('claudePresets', () => {
  describe('getAgentType', () => {
    it('returns claude-code config for claude-code', () => {
      const agent = getAgentType('claude-code');
      expect(agent.value).toBe('claude-code');
      expect(agent.label).toBe('Claude Code');
    });

    it('returns codex config for codex', () => {
      const agent = getAgentType('codex');
      expect(agent.value).toBe('codex');
      expect(agent.label).toBe('Codex');
    });

    it('falls back to first agent type for unknown agent', () => {
      const agent = getAgentType('unknown-agent' as any);
      expect(agent).toEqual(AGENT_TYPES[0]);
    });
  });

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

  describe('getModelsForAgent', () => {
    it('returns CLAUDE_MODELS for claude-code', () => {
      const models = getModelsForAgent('claude-code');
      expect(models).toBe(CLAUDE_MODELS);
    });

    it('returns CODEX_MODELS_FALLBACK for codex without dynamic models', () => {
      const models = getModelsForAgent('codex');
      expect(models).toBe(CODEX_MODELS_FALLBACK);
    });

    it('returns CODEX_MODELS_FALLBACK for codex with empty dynamic models', () => {
      const models = getModelsForAgent('codex', []);
      expect(models).toBe(CODEX_MODELS_FALLBACK);
    });

    it('returns dynamic codex models when provided', () => {
      const dynamic = [{ id: 'gpt-5', name: 'GPT-5' }];
      const models = getModelsForAgent('codex', dynamic);
      expect(models).toEqual([{ value: 'gpt-5', label: 'GPT-5' }]);
    });

    it('ignores dynamic codex models for claude-code agent', () => {
      const dynamic = [{ id: 'gpt-5', name: 'GPT-5' }];
      const models = getModelsForAgent('claude-code', dynamic);
      expect(models).toBe(CLAUDE_MODELS);
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
    it('returns false for haiku', () => {
      expect(modelSupports1m('claude-haiku-4-5-20251001')).toBe(false);
    });

    it('returns true for sonnet/opus', () => {
      expect(modelSupports1m('claude-sonnet-4-6')).toBe(true);
      expect(modelSupports1m('claude-opus-4-7')).toBe(true);
    });
  });

  describe('getContextWindowOptionsForModel', () => {
    it('returns only 200k for haiku', () => {
      const opts = getContextWindowOptionsForModel('claude-haiku-4-5-20251001');
      expect(opts.map((o) => o.value)).toEqual([200_000]);
    });

    it('returns 200k/500k/1M for sonnet/opus', () => {
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

    it('passes 1M through for sonnet/opus', () => {
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
  });
});
