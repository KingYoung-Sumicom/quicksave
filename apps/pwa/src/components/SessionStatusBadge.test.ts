// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import type { ClaudeSessionSummary } from '@sumicom/quicksave-shared';
import { isSessionUnread, sessionStatusKey } from './SessionStatusBadge';

function makeSummary(overrides: Partial<ClaudeSessionSummary> = {}): ClaudeSessionSummary {
  return {
    sessionId: 's1',
    summary: 'subject',
    lastModified: 1_000,
    isActive: true,
    archived: false,
    isStreaming: false,
    hasPendingInput: false,
    ...overrides,
  };
}

describe('isSessionUnread', () => {
  it('returns false when lastReadAt is missing — treats absence as "feature not engaged"', () => {
    // Critical for back-compat: a stale agent build / pre-feature registry
    // entry omits the field; we must not flood the list purple in that case.
    const session = makeSummary({ lastReadAt: undefined, lastTurnEndedAt: 5_000 });
    expect(isSessionUnread(session)).toBe(false);
  });

  it('returns false when no turn has ever ended — nothing to read', () => {
    const session = makeSummary({ lastReadAt: 1_000, lastTurnEndedAt: undefined });
    expect(isSessionUnread(session)).toBe(false);
  });

  it('returns false when lastTurnEndedAt is 0 (treats 0 as no-turn-yet)', () => {
    const session = makeSummary({ lastReadAt: 1_000, lastTurnEndedAt: 0 });
    expect(isSessionUnread(session)).toBe(false);
  });

  it('returns true when lastReadAt is older than lastTurnEndedAt', () => {
    const session = makeSummary({ lastReadAt: 1_000, lastTurnEndedAt: 5_000 });
    expect(isSessionUnread(session)).toBe(true);
  });

  it('returns false when lastReadAt equals lastTurnEndedAt', () => {
    const session = makeSummary({ lastReadAt: 5_000, lastTurnEndedAt: 5_000 });
    expect(isSessionUnread(session)).toBe(false);
  });

  it('returns false when lastReadAt is newer than lastTurnEndedAt', () => {
    const session = makeSummary({ lastReadAt: 9_000, lastTurnEndedAt: 5_000 });
    expect(isSessionUnread(session)).toBe(false);
  });

  it('allows inactive sessions to be unread (CLI ended with output you never saw)', () => {
    const session = makeSummary({
      isActive: false,
      lastReadAt: 1_000,
      lastTurnEndedAt: 5_000,
    });
    expect(isSessionUnread(session)).toBe(true);
  });
});

describe('sessionStatusKey priority', () => {
  it('pending wins over thinking (permission request arrives mid-stream → orange beats blue)', () => {
    const session = makeSummary({
      isStreaming: true,
      hasPendingInput: true,
    });
    expect(sessionStatusKey(session)).toBe('pending');
  });

  it('pending wins over unread (orange action cue beats purple new-content cue)', () => {
    const session = makeSummary({
      hasPendingInput: true,
      lastReadAt: 1_000,
      lastTurnEndedAt: 5_000,
    });
    expect(sessionStatusKey(session)).toBe('pending');
  });

  it('thinking wins over unread (live cursor cue beats new-output cue)', () => {
    const session = makeSummary({
      isStreaming: true,
      lastReadAt: 1_000,
      lastTurnEndedAt: 5_000,
    });
    expect(sessionStatusKey(session)).toBe('thinking');
  });

  it('unread wins over closed (an ended session with unseen output still flags purple)', () => {
    const session = makeSummary({
      isActive: false,
      lastReadAt: 1_000,
      lastTurnEndedAt: 5_000,
    });
    expect(sessionStatusKey(session)).toBe('unread');
  });

  it('pending shows even when session is already read (not gated on unread state)', () => {
    const session = makeSummary({
      hasPendingInput: true,
      lastReadAt: 6_000,
      lastTurnEndedAt: 5_000,
    });
    expect(sessionStatusKey(session)).toBe('pending');
  });

  it('closed wins for inactive + read sessions', () => {
    const session = makeSummary({
      isActive: false,
      lastReadAt: 6_000,
      lastTurnEndedAt: 5_000,
    });
    expect(sessionStatusKey(session)).toBe('closed');
  });

  it('standby for active + read + nothing else going on', () => {
    const session = makeSummary({
      lastReadAt: 6_000,
      lastTurnEndedAt: 5_000,
    });
    expect(sessionStatusKey(session)).toBe('standby');
  });

  it('back-compat: missing lastReadAt yields standby on an active session, not unread', () => {
    const session = makeSummary({
      lastReadAt: undefined,
      lastTurnEndedAt: 5_000,
    });
    expect(sessionStatusKey(session)).toBe('standby');
  });
});
