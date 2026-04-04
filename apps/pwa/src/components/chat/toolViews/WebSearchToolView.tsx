export function WebSearchToolView({ input }: { input: Record<string, unknown> }) {
  const query = (input.query as string) || '?';

  return (
    <div>
      <span className="text-cyan-400">Search</span>{' '}
      <span className="text-slate-200">{query}</span>
    </div>
  );
}
