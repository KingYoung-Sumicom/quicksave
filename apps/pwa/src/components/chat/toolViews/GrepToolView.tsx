export function GrepToolView({ input }: { input: Record<string, unknown> }) {
  const pattern = (input.pattern as string) || '?';
  const path = input.path as string | undefined;
  const glob = input.glob as string | undefined;

  return (
    <>
      <span className="text-purple-400">Grep</span>{' '}
      <span className="font-mono text-emerald-400">{pattern}</span>
      {(path || glob) && (
        <span className="text-slate-500"> in {glob || path}</span>
      )}
    </>
  );
}
