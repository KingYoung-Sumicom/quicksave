// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';

const COLLAPSED_LIMIT = 8;

export function TodoWriteToolView({ input }: { input: Record<string, unknown> }) {
  const raw = input.todos;
  const todos: Array<{ content: string; status: string }> = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? (() => { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; } })()
      : [];
  const [expanded, setExpanded] = useState(false);

  if (todos.length === 0) {
    return <span className="text-teal-400">Update task list</span>;
  }

  const statusIcon = (s: string) =>
    s === 'completed' ? '✅' : s === 'in_progress' ? '▶️' : '⬜';

  const overflow = todos.length - COLLAPSED_LIMIT;
  const visible = expanded || overflow <= 0 ? todos : todos.slice(0, COLLAPSED_LIMIT);

  return (
    <div>
      <span className="text-teal-400">Tasks</span>
      <div className="mt-1 space-y-0.5">
        {visible.map((t, i) => (
          <div key={i} className="text-slate-300 truncate">
            {statusIcon(t.status)} {t.content}
          </div>
        ))}
        {overflow > 0 && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-slate-500 hover:text-slate-300 transition-colors"
          >
            {expanded ? 'Show less' : `+${overflow} more`}
          </button>
        )}
      </div>
    </div>
  );
}
