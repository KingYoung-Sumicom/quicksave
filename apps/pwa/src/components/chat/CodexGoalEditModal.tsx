// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import {
  parseTokenBudget,
  type GoalSnapshot,
} from './codexGoalModel';

interface CodexGoalEditModalProps {
  goal: GoalSnapshot;
  busy: boolean;
  error: string | null;
  onSave: (params: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
}

export function CodexGoalEditModal({
  goal,
  busy,
  error,
  onSave,
  onClose,
}: CodexGoalEditModalProps) {
  const [objective, setObjective] = useState(goal.objective);
  const [tokenBudget, setTokenBudget] = useState(goal.tokenBudget === null ? '' : String(goal.tokenBudget));

  useEffect(() => {
    setObjective(goal.objective);
    setTokenBudget(goal.tokenBudget === null ? '' : String(goal.tokenBudget));
  }, [goal.objective, goal.tokenBudget]);

  const parsedBudget = parseTokenBudget(tokenBudget);
  const saveDisabled = busy || objective.trim().length === 0 || parsedBudget === 'invalid';

  return (
    <Modal title="Edit Codex goal" onClose={busy ? () => {} : onClose} maxWidth="max-w-lg" backdropClose={!busy}>
      <div className="space-y-4 p-4 text-sm">
        {error && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {error}
          </div>
        )}

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-300">Objective</span>
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            rows={5}
            disabled={busy}
            className="w-full resize-none rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none disabled:opacity-60"
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
            disabled={busy}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none disabled:opacity-60"
            placeholder="No budget"
          />
          {parsedBudget === 'invalid' && (
            <span className="text-xs text-rose-300">Use a non-negative integer or leave blank.</span>
          )}
        </label>

        <div className="flex justify-end gap-2 border-t border-slate-700 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSave({
              objective: objective.trim(),
              tokenBudget: parsedBudget === '' ? null : parsedBudget,
            })}
            disabled={saveDisabled}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
