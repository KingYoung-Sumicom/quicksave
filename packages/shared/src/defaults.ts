import type { AgentId } from './types.js';

/**
 * Shared defaults — single source of truth for both agent and PWA.
 * Import from '@sumicom/quicksave-shared'.
 */

export const DEFAULT_MODEL = 'claude-opus-4-7';
export const DEFAULT_PERMISSION_MODE = 'acceptEdits';
export const DEFAULT_REASONING_EFFORT = 'medium' as const;
export const DEFAULT_AGENT: AgentId = 'claude-code';
