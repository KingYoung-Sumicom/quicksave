import { describe, it, expect } from 'vitest';
import {
  getAgentType,
  normalizeAgentId,
  getModelsForAgent,
  codexModelsToOptions,
  CLAUDE_MODELS,
  CODEX_MODELS_FALLBACK,
  AGENT_TYPES,
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
});
