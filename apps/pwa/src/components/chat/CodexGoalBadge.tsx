// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import type { ConfigValue, SessionControlRequestResponsePayload } from '@sumicom/quicksave-shared';
import { useSessionConfig } from '../../hooks/useSessionConfig';
import { normalizeAgentId } from '../../lib/claudePresets';
import { Modal } from '../ui/Modal';

type SendControlRequest = (
  sessionId: string,
  subtype: string,
  params?: Record<string, unknown>,
) => Promise<SessionControlRequestResponsePayload>;

interface CodexGoalBadgeProps {
  sessionId: string;
  onSendControlRequest?: SendControlRequest;
}

interface GoalSnapshot {
  present: boolean;
  objective: string;
  status: string | null;
  tokenBudget: number | null;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
  updatedAt: number | null;
}

type GoalTone = 'active' | 'paused' | 'blocked' | 'complete' | 'off';

const BADGE_CLASS: Record<GoalTone, string> = {
  active: 'bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30',
  paused: 'bg-amber-600/20 text-amber-300 hover:bg-amber-600/30',
  blocked: 'bg-rose-600/20 text-rose-300 hover:bg-rose-600/30',
  complete: 'bg-slate-700/60 text-slate-400 hover:bg-slate-700',
  off: 'bg-slate-700/60 text-slate-400 hover:bg-slate-700',
};

const DOT_CLASS: Record<GoalTone, string> = {
  active: 'bg-emerald-400',
  paused: 'bg-amber-400',
  blocked: 'bg-rose-400',
  complete: 'bg-slate-400',
  off: 'bg-slate-500',
};

export function CodexGoalBadge({ sessionId, onSendControlRequest }: CodexGoalBadgeProps) {
  const config = useSessionConfig(sessionId);
  const [open, setOpen] = useState(false);
  const sessionAgent = normalizeAgentId((config.agent as string | undefined) ?? 'claude-code');
  if (sessionAgent !== 'codex') return null;

  const goal = goalSnapshotFromConfig(config);
  const tone = goalTone(goal.status, goal.present);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 rounded-md transition-colors max-w-[14rem]',
          BADGE_CLASS[tone],
        )}
        title={goalBadgeTitle(goal)}
      >
        <span className={clsx('h-1.5 w-1.5 rounded-full shrink-0', DOT_CLASS[tone])} />
        <span className="font-mono shrink-0">Goal</span>
        <span className="truncate">{goal.present ? goalStatusLabel(goal.status) : 'off'}</span>
      </button>

      {open && (
        <CodexGoalModal
          sessionId={sessionId}
          goal={goal}
          onSendControlRequest={onSendControlRequest}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function CodexGoalModal({
  sessionId,
  goal,
  onSendControlRequest,
  onClose,
}: {
  sessionId: string;
  goal: GoalSnapshot;
  onSendControlRequest?: SendControlRequest;
  onClose: () => void;
}) {
  const [objective, setObjective] = useState(goal.objective);
  const [tokenBudget, setTokenBudget] = useState(goal.tokenBudget === null ? '' : String(goal.tokenBudget));
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!goal.present) {
      setObjective('');
      setTokenBudget('');
      return;
    }
    setObjective(goal.objective);
    setTokenBudget(goal.tokenBudget === null ? '' : String(goal.tokenBudget));
  }, [goal.objective, goal.present, goal.tokenBudget]);

  const canSend = Boolean(onSendControlRequest) && !busy;
  const parsedBudget = parseTokenBudget(tokenBudget);
  const saveDisabled = !canSend || objective.trim().length === 0 || parsedBudget === 'invalid';

  const send = async (label: string, subtype: string, params?: Record<string, unknown>) => {
    if (!onSendControlRequest) {
      setError('Control request API not available.');
      return;
    }
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      const response = await onSendControlRequest(sessionId, subtype, params);
      if (!response.success) throw new Error(response.error || `${label} failed`);
      setMessage(goalActionMessage(subtype, response.response));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Codex goal" onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-4 p-4 text-sm">
        {message && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            {message}
          </div>
        )}
        {error && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 text-xs">
          <GoalStat label="Status" value={goal.present ? goalStatusLabel(goal.status) : 'Off'} />
          <GoalStat label="Tokens" value={goal.tokensUsed === null ? '-' : formatNumber(goal.tokensUsed)} />
          <GoalStat label="Budget" value={goal.tokenBudget === null ? 'None' : formatNumber(goal.tokenBudget)} />
          <GoalStat label="Time" value={goal.timeUsedSeconds === null ? '-' : formatDuration(goal.timeUsedSeconds)} />
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Objective</span>
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            rows={4}
            className="w-full resize-none rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            placeholder="What should Codex keep working toward?"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Token budget</span>
          <input
            type="text"
            inputMode="numeric"
            value={tokenBudget}
            onChange={(e) => setTokenBudget(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            placeholder="No budget"
          />
          {parsedBudget === 'invalid' && (
            <span className="text-xs text-rose-300">Use a non-negative integer or leave blank.</span>
          )}
        </label>

        {goal.updatedAt !== null && (
          <p className="text-xs text-slate-500">Updated {formatDate(goal.updatedAt)}</p>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-700 pt-4">
          <button
            type="button"
            onClick={() => void send('Refresh', 'goal.get')}
            disabled={!canSend}
            className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void send(goal.status === 'paused' ? 'Resume' : 'Pause', goal.status === 'paused' ? 'goal.resume' : 'goal.pause')}
            disabled={!canSend || !goal.present}
            className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {goal.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={() => void send('Clear', 'goal.clear')}
            disabled={!canSend || !goal.present}
            className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => void send('Save', 'goal.set', {
              objective: objective.trim(),
              tokenBudget: parsedBudget === '' ? null : parsedBudget,
            })}
            disabled={saveDisabled}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'Save' ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function GoalStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-700 bg-slate-900/60 px-3 py-2">
      <div className="text-[11px] uppercase text-slate-500">{label}</div>
      <div className="mt-1 truncate font-mono text-xs text-slate-200">{value}</div>
    </div>
  );
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

function numberOrNull(value: ConfigValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseTokenBudget(value: string): number | '' | 'invalid' {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}

function goalBadgeTitle(goal: GoalSnapshot): string {
  if (!goal.present) return 'Goal mode off';
  return goal.objective ? `Goal ${goalStatusLabel(goal.status)}: ${goal.objective}` : `Goal ${goalStatusLabel(goal.status)}`;
}

function goalActionMessage(subtype: string, response: unknown): string {
  if (subtype === 'goal.clear') return 'Goal cleared.';
  const goal = extractGoal(response);
  if (!goal) return 'Goal updated.';
  const status = typeof goal.status === 'string' ? goalStatusLabel(goal.status) : 'updated';
  const objective = typeof goal.objective === 'string' ? goal.objective.trim() : '';
  return objective ? `Goal ${status}: ${objective}` : `Goal ${status}.`;
}

function extractGoal(response: unknown): Record<string, unknown> | null {
  if (typeof response !== 'object' || response === null) return null;
  const goal = (response as { goal?: unknown }).goal;
  return typeof goal === 'object' && goal !== null ? goal as Record<string, unknown> : null;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  if (minutes < 60) return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const hourMinutes = minutes % 60;
  return hourMinutes ? `${hours}h ${hourMinutes}m` : `${hours}h`;
}

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}
