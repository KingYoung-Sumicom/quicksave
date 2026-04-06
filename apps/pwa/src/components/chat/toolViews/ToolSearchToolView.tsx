export function ToolSearchToolView({ input }: { input: Record<string, unknown> }) {
  const query = (input.query as string) || '';

  return (
    <>
      <span className="text-pink-400">Search tools</span>
      {query && <span className="text-slate-400 ml-1.5 font-mono">{query}</span>}
    </>
  );
}
