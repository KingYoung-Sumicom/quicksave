export function TodoWriteToolView({ input }: { input: Record<string, unknown> }) {
  const raw = input.todos;
  const todos: Array<{ content: string; status: string }> = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? (() => { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; } })()
      : [];
  if (todos.length === 0) {
    return <span className="text-teal-400">Update task list</span>;
  }

  const statusIcon = (s: string) =>
    s === 'completed' ? '\u2705' : s === 'in_progress' ? '\u25b6\ufe0f' : '\u2b1c';

  return (
    <div>
      <span className="text-teal-400">Tasks</span>
      <div className="mt-1 space-y-0.5">
        {todos.slice(0, 8).map((t, i) => (
          <div key={i} className="text-slate-300 truncate">
            {statusIcon(t.status)} {t.content}
          </div>
        ))}
        {todos.length > 8 && (
          <div className="text-slate-500">+{todos.length - 8} more</div>
        )}
      </div>
    </div>
  );
}
