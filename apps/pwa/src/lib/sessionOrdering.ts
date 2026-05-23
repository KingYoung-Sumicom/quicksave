// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ClaudeSessionSummary } from '@sumicom/quicksave-shared';
import { isSessionUnread } from '../components/SessionStatusBadge';

export function isPendingMissionActive(session: Pick<ClaudeSessionSummary, 'pendingMission'>, now = Date.now()): boolean {
  const mission = session.pendingMission;
  return typeof mission?.until === 'number' && mission.until > now;
}

export function sessionListRank(session: ClaudeSessionSummary, now = Date.now()): number {
  if (isSessionUnread(session)) return 5;
  if (session.hasPendingInput) return 4;
  if (isPendingMissionActive(session, now)) return 0.5;
  if (session.isStreaming) return 3;
  if (session.isActive) return 2;
  return 0;
}

export function compareSessionsForList(a: ClaudeSessionSummary, b: ClaudeSessionSummary, now = Date.now()): number {
  const rankA = sessionListRank(a, now);
  const rankB = sessionListRank(b, now);
  if (rankA !== rankB) return rankB - rankA;
  const tsA = a.lastPromptAt ?? a.lastModified;
  const tsB = b.lastPromptAt ?? b.lastModified;
  return tsB - tsA;
}
