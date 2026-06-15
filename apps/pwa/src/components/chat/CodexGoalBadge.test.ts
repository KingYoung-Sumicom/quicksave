// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  goalConfirmMessage,
  goalPauseResumeAction,
  goalSnapshotFromConfig,
  goalStatusLabel,
  goalStopAction,
  goalTone,
  parseTokenBudget,
  type GoalSnapshot,
} from './codexGoalModel';

describe('CodexGoalBadge helpers', () => {
  it('maps session config into a goal snapshot', () => {
    expect(goalSnapshotFromConfig({
      codexGoalPresent: true,
      codexGoalObjective: 'Ship goal UI',
      codexGoalStatus: 'active',
      codexGoalTokenBudget: 1000,
      codexGoalTokensUsed: 250,
      codexGoalTimeUsedSeconds: 90,
      codexGoalUpdatedAt: 12345,
    })).toEqual({
      present: true,
      objective: 'Ship goal UI',
      status: 'active',
      tokenBudget: 1000,
      tokensUsed: 250,
      timeUsedSeconds: 90,
      updatedAt: 12345,
    });
  });

  it('treats cleared goal config as off', () => {
    expect(goalSnapshotFromConfig({
      codexGoalPresent: false,
      codexGoalObjective: null,
      codexGoalStatus: null,
    })).toMatchObject({
      present: false,
      objective: '',
      status: null,
    });
  });

  it('maps goal statuses to badge tones and labels', () => {
    expect(goalTone('active', true)).toBe('active');
    expect(goalTone('paused', true)).toBe('paused');
    expect(goalTone('blocked', true)).toBe('blocked');
    expect(goalTone('usageLimited', true)).toBe('blocked');
    expect(goalTone('budgetLimited', true)).toBe('blocked');
    expect(goalTone('complete', true)).toBe('complete');
    expect(goalTone('active', false)).toBe('off');

    expect(goalStatusLabel('usageLimited')).toBe('usage limited');
    expect(goalStatusLabel('budgetLimited')).toBe('budget limited');
    expect(goalStatusLabel(null)).toBe('unknown');
  });

  it('chooses goal control actions for pause, resume, and stop', () => {
    const activeGoal: GoalSnapshot = {
      present: true,
      objective: 'Ship goal UI',
      status: 'active',
      tokenBudget: null,
      tokensUsed: null,
      timeUsedSeconds: null,
      updatedAt: null,
    };
    const pausedGoal = { ...activeGoal, status: 'paused' };

    expect(goalPauseResumeAction(activeGoal)).toMatchObject({ label: 'Pause', subtype: 'goal.pause' });
    expect(goalPauseResumeAction(pausedGoal)).toMatchObject({ label: 'Resume', subtype: 'goal.resume' });
    expect(goalStopAction).toMatchObject({ label: 'Stop', subtype: 'goal.clear', variant: 'danger' });
    expect(goalConfirmMessage(goalStopAction, activeGoal)).toContain('Ship goal UI');
  });

  it('parses token budget form values', () => {
    expect(parseTokenBudget('')).toBe('');
    expect(parseTokenBudget(' 123 ')).toBe(123);
    expect(parseTokenBudget('-1')).toBe('invalid');
    expect(parseTokenBudget('1.5')).toBe('invalid');
  });
});
