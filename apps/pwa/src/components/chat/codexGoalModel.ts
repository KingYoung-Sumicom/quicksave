// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ConfigValue, SessionControlRequestResponsePayload } from '@sumicom/quicksave-shared';

export type SendControlRequest = (
  sessionId: string,
  subtype: string,
  params?: Record<string, unknown>,
) => Promise<SessionControlRequestResponsePayload>;

export interface GoalSnapshot {
  present: boolean;
  objective: string;
  status: string | null;
  tokenBudget: number | null;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
  updatedAt: number | null;
}

export type GoalTone = 'active' | 'paused' | 'blocked' | 'complete' | 'off';

export interface GoalConfirmAction {
  kind: 'pause' | 'resume' | 'stop';
  label: string;
  subtype: 'goal.pause' | 'goal.resume' | 'goal.clear';
  variant: 'primary' | 'danger';
}

export function goalSnapshotFromConfig(config: Record<string, ConfigValue>): GoalSnapshot {
  return {
    present: config.codexGoalPresent === true,
    objective: typeof config.codexGoalObjective === 'string' ? config.codexGoalObjective : '',
    status: typeof config.codexGoalStatus === 'string' ? config.codexGoalStatus : null,
    tokenBudget: numberOrNull(config.codexGoalTokenBudget),
    tokensUsed: numberOrNull(config.codexGoalTokensUsed),
    timeUsedSeconds: numberOrNull(config.codexGoalTimeUsedSeconds),
    updatedAt: numberOrNull(config.codexGoalUpdatedAt),
  };
}

export function goalTone(status: string | null, present: boolean): GoalTone {
  if (!present) return 'off';
  switch (status) {
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    case 'blocked':
    case 'usageLimited':
    case 'budgetLimited':
      return 'blocked';
    case 'complete':
      return 'complete';
    default:
      return 'off';
  }
}

export function goalStatusLabel(status: string | null): string {
  switch (status) {
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    case 'blocked':
      return 'blocked';
    case 'usageLimited':
      return 'usage limited';
    case 'budgetLimited':
      return 'budget limited';
    case 'complete':
      return 'complete';
    default:
      return 'unknown';
  }
}

export function parseTokenBudget(value: string): number | '' | 'invalid' {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}

export function goalActionMessage(subtype: string, response: unknown): string {
  if (subtype === 'goal.clear') return 'Goal stopped.';
  const goal = extractGoal(response);
  if (!goal) return 'Goal updated.';
  const status = typeof goal.status === 'string' ? goalStatusLabel(goal.status) : 'updated';
  const objective = typeof goal.objective === 'string' ? goal.objective.trim() : '';
  return objective ? `Goal ${status}: ${objective}` : `Goal ${status}.`;
}

export function goalPauseResumeAction(goal: GoalSnapshot): GoalConfirmAction {
  return goal.status === 'paused'
    ? {
        kind: 'resume',
        label: 'Resume',
        subtype: 'goal.resume',
        variant: 'primary',
      }
    : {
        kind: 'pause',
        label: 'Pause',
        subtype: 'goal.pause',
        variant: 'primary',
      };
}

export const goalStopAction: GoalConfirmAction = {
  kind: 'stop',
  label: 'Stop',
  subtype: 'goal.clear',
  variant: 'danger',
};

export function goalConfirmTitle(action: GoalConfirmAction): string {
  switch (action.kind) {
    case 'pause':
      return 'Pause Codex goal?';
    case 'resume':
      return 'Resume Codex goal?';
    case 'stop':
      return 'Stop Codex goal?';
  }
}

export function goalConfirmMessage(action: GoalConfirmAction, goal: GoalSnapshot): string {
  const objective = goal.objective.trim();
  const suffix = objective ? `\n\n${objective}` : '';
  switch (action.kind) {
    case 'pause':
      return `Codex will keep the goal but stop actively progressing it until you resume.${suffix}`;
    case 'resume':
      return `Codex will resume goal mode with this objective.${suffix}`;
    case 'stop':
      return `This clears the active Codex goal from the session.${suffix}`;
  }
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  if (minutes < 60) return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const hourMinutes = minutes % 60;
  return hourMinutes ? `${hours}h ${hourMinutes}m` : `${hours}h`;
}

export function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

function numberOrNull(value: ConfigValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractGoal(response: unknown): Record<string, unknown> | null {
  if (typeof response !== 'object' || response === null) return null;
  const goal = (response as { goal?: unknown }).goal;
  return typeof goal === 'object' && goal !== null ? goal as Record<string, unknown> : null;
}
