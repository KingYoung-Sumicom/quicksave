// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * Voice intermediary ("AI coworker") — a daemon-side tool-calling LLM that
 * interprets the coding agent's output and lets the user steer it by voice.
 * Brain + TTS ride the same OpenAI-compatible endpoint as STT (VoiceConfig).
 *
 * See docs/references/quicksave-architecture.en.md (section two).
 */
export { VoiceIntermediaryManager } from './manager.js';
export type { VoiceManagerBridge } from './manager.js';
export { VOICE_AGENT_TOOLS, formatCardForBrain } from './tools.js';
export type { CodingSessionBridge } from './tools.js';
export { loadMemory, appendMemory } from './memory.js';
