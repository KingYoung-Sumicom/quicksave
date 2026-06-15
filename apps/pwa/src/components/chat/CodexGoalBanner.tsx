// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useSessionConfig } from '../../hooks/useSessionConfig';
import { normalizeAgentId } from '../../lib/claudePresets';
import { ConfirmModal } from '../ui/ConfirmModal';
import {
  formatDate,
  formatDuration,
  formatNumber,
  goalActionMessage,
  goalConfirmMessage,
  goalConfirmTitle,
  goalPauseResumeAction,
  goalSnapshotFromConfig,
  goalStatusLabel,
  goalStopAction,
  goalTone,
  type GoalConfirmAction,
  type GoalTone,
  type SendControlRequest,
} from './codexGoalModel';
import { CodexGoalEditModal } from './CodexGoalEditModal';

interface CodexGoalBannerProps {
  sessionId: string;
  onSendControlRequest?: SendControlRequest;
}

const BANNER_CLASS: Record<GoalTone, string> = {
  active: 'border-emerald-500/30 bg-emerald-950/25 text-emerald-50',
  paused: 'border-amber-500/35 bg-amber-950/25 text-amber-50',
  blocked: 'border-rose-500/35 bg-rose-950/25 text-rose-50',
  complete: 'border-slate-600 bg-slate-800/80 text-slate-100',
  off: 'border-slate-700 bg-slate-800 text-slate-100',
};

const DOT_CLASS: Record<GoalTone, string> = {
  active: 'bg-emerald-300',
  paused: 'bg-amber-300',
  blocked: 'bg-rose-300',
  complete: 'bg-slate-400',
  off: 'bg-slate-500',
};

export function CodexGoalBanner({ sessionId, onSendControlRequest }: CodexGoalBannerProps) {
  const config = useSessionConfig(sessionId);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<GoalConfirmAction | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const sessionAgent = normalizeAgentId((config.agent as string | undefined) ?? 'claude-code');
  const goal = goalSnapshotFromConfig(config);
  const tone = goalTone(goal.status, goal.present);
  const pauseResumeAction = goalPauseResumeAction(goal);
  const canSend = Boolean(onSendControlRequest) && !busy;

  useEffect(() => {
    setExpanded(false);
  }, [sessionId]);

  const send = async (
    label: string,
    subtype: string,
    params?: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!onSendControlRequest) {
      setError('Control request API not available.');
      return false;
    }
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      const response = await onSendControlRequest(sessionId, subtype, params);
      if (!response.success) throw new Error(response.error || `${label} failed`);
      setMessage(goalActionMessage(subtype, response.response));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleConfirmAction = async () => {
    if (!confirmAction) return;
    const action = confirmAction;
    const ok = await send(action.label, action.subtype);
    if (ok) setConfirmAction(null);
  };

  if (sessionAgent !== 'codex' || !goal.present) return null;

  return (
    <>
      <div className={clsx('border-b px-4 py-3 text-sm', BANNER_CLASS[tone])}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
                aria-label={expanded ? 'Collapse Codex goal' : 'Expand Codex goal'}
                title={expanded ? 'Collapse goal' : 'Expand goal'}
                className="rounded p-0.5 text-slate-300 hover:bg-white/10 hover:text-slate-50"
              >
                <ChevronIcon expanded={expanded} />
              </button>
              <span className={clsx('h-2 w-2 shrink-0 rounded-full', DOT_CLASS[tone])} />
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Codex goal
              </span>
              <span className="rounded border border-white/10 bg-black/15 px-1.5 py-0.5 text-[11px] font-medium text-slate-200">
                {goalStatusLabel(goal.status)}
              </span>
            </div>
            <div
              title={expanded ? undefined : goal.objective}
              className={clsx(
                'mt-1.5 text-sm leading-5 text-slate-50',
                expanded ? 'whitespace-pre-wrap break-words' : 'truncate',
              )}
            >
              {goal.objective || 'No objective recorded.'}
            </div>
            {expanded && (
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-300">
                <GoalMeta label="Tokens" value={goal.tokensUsed === null ? '-' : formatNumber(goal.tokensUsed)} />
                <GoalMeta label="Budget" value={goal.tokenBudget === null ? 'None' : formatNumber(goal.tokenBudget)} />
                <GoalMeta label="Time" value={goal.timeUsedSeconds === null ? '-' : formatDuration(goal.timeUsedSeconds)} />
                {goal.updatedAt !== null && <GoalMeta label="Updated" value={formatDate(goal.updatedAt)} />}
              </div>
            )}
            {(message || error) && (
              <div
                className={clsx(
                  'mt-2 rounded-md border px-2 py-1.5 text-xs',
                  error
                    ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
                )}
              >
                {error ?? message}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5 sm:justify-end">
            <GoalActionButton
              label={pauseResumeAction.label}
              title={`${pauseResumeAction.label} goal`}
              disabled={!canSend}
              onClick={() => setConfirmAction(pauseResumeAction)}
              icon={pauseResumeAction.kind === 'resume' ? <PlayIcon /> : <PauseIcon />}
            />
            <GoalActionButton
              label="Edit"
              title="Edit goal"
              disabled={Boolean(busy)}
              onClick={() => {
                setError(null);
                setEditOpen(true);
              }}
              icon={<EditIcon />}
            />
            <GoalActionButton
              label="Stop"
              title="Stop goal"
              disabled={!canSend}
              variant="danger"
              onClick={() => setConfirmAction(goalStopAction)}
              icon={<StopIcon />}
            />
          </div>
        </div>
      </div>

      {confirmAction && (
        <ConfirmModal
          title={goalConfirmTitle(confirmAction)}
          message={goalConfirmMessage(confirmAction, goal)}
          confirmLabel={confirmAction.label}
          variant={confirmAction.variant}
          busy={busy === confirmAction.label}
          onConfirm={() => void handleConfirmAction()}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {editOpen && (
        <CodexGoalEditModal
          goal={goal}
          busy={busy === 'Save'}
          error={error}
          onClose={() => setEditOpen(false)}
          onSave={async (params) => {
            const ok = await send('Save', 'goal.set', params);
            if (ok) setEditOpen(false);
            return ok;
          }}
        />
      )}
    </>
  );
}

function GoalMeta({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-black/10 px-1.5 py-0.5">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono text-slate-200">{value}</span>
    </span>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={clsx('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GoalActionButton({
  label,
  title,
  icon,
  disabled,
  onClick,
  variant = 'neutral',
}: {
  label: string;
  title: string;
  icon: JSX.Element;
  disabled?: boolean;
  onClick: () => void;
  variant?: 'neutral' | 'danger';
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex min-w-[4.75rem] items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'danger'
          ? 'border-rose-400/30 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20'
          : 'border-white/10 bg-slate-900/50 text-slate-100 hover:bg-slate-800',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function PauseIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M5.5 4v8M10.5 4v8" strokeLinecap="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M5.5 4.5v7l5.5-3.5-5.5-3.5z" strokeLinejoin="round" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 11.5l-.5 1.8 1.8-.5 6.2-6.2-1.3-1.3L4 11.5z" strokeLinejoin="round" />
      <path d="M9.6 4.9l1.3-1.3 1.5 1.5-1.3 1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M5 5h6v6H5z" strokeLinejoin="round" />
    </svg>
  );
}
