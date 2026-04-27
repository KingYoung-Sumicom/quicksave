import type { AgentId } from './types.js';

/**
 * Shared defaults — single source of truth for both agent and PWA.
 * Import from '@sumicom/quicksave-shared'.
 */

// Claude defaults. The wire protocol's `ClaudePreferences` and the PWA's
// claude-agent prefs both seed from these.
export const DEFAULT_MODEL = 'claude-opus-4-7';
export const DEFAULT_PERMISSION_MODE = 'auto';
export const DEFAULT_REASONING_EFFORT = 'high' as const;
export const DEFAULT_AGENT: AgentId = 'claude-code';
export const DEFAULT_SANDBOXED = true;
/** Auto-compact window for Claude Code sessions. Claude Code's CLI
 *  auto-promotes Sonnet/Opus to 1M context unless told otherwise; we cap at
 *  200k by default so usage and pricing stay predictable. Users can opt up
 *  to 500k or 1M per-session from the settings drawer. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const CONTEXT_WINDOW_OPTIONS = [200_000, 500_000, 1_000_000] as const;

// Codex defaults — separate from Claude because the SDKs use different
// enums (codex preset ids vs Claude's permissionMode strings; codex's
// reasoning union differs too). Used to seed the codex agent's prefs.
export const DEFAULT_CODEX_MODEL = 'gpt-5.5';
export const DEFAULT_CODEX_PERMISSION_MODE = 'default';
export const DEFAULT_CODEX_REASONING_EFFORT = 'medium';

/** Prompt cache lifetime used by the PWA countdown above the chat input. */
export const DEFAULT_KV_CACHE_LIFETIME_MS = 60 * 60 * 1000;
