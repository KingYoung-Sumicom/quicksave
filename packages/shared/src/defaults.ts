import type { AgentId } from './types.js';

/**
 * Shared defaults — single source of truth for both agent and PWA.
 * Import from '@sumicom/quicksave-shared'.
 */

export const DEFAULT_MODEL = 'claude-opus-4-7';
export const DEFAULT_PERMISSION_MODE = 'auto';
export const DEFAULT_REASONING_EFFORT = 'high' as const;
export const DEFAULT_AGENT: AgentId = 'claude-code';
export const DEFAULT_SANDBOXED = true;

/** Prompt cache lifetime used by the PWA countdown above the chat input. */
export const DEFAULT_KV_CACHE_LIFETIME_MS = 60 * 60 * 1000;
