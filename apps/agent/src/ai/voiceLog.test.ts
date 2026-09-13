// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { shouldLogVoiceEvent } from './voiceLog.js';

describe('shouldLogVoiceEvent', () => {
  it('retains capture diagnostics when general voice logging is disabled', () => {
    expect(shouldLogVoiceEvent('capture.error', false, undefined)).toBe(true);
    expect(shouldLogVoiceEvent('capture.attempt_started', false, undefined)).toBe(true);
  });

  it('keeps transcript-bearing voice events debug-only', () => {
    expect(shouldLogVoiceEvent('asr.final_fragment', false, undefined)).toBe(false);
    expect(shouldLogVoiceEvent('intent.endpoint', false, undefined)).toBe(false);
    expect(shouldLogVoiceEvent('asr.final_fragment', true, undefined)).toBe(true);
  });

  it('honors an explicit logging opt-out', () => {
    expect(shouldLogVoiceEvent('capture.error', true, '0')).toBe(false);
  });
});
