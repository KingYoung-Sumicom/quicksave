export function GlobToolView({ input }: { input: Record<string, unknown> }) {
  const pattern = (input.pattern as string) || '?';
  const path = input.path as string | undefined;

  return (
    <>
      <span className="text-purple-400">Glob</span>{' '}
      <span className="font-mono">{pattern}</span>
      {path && <span className="text-slate-500"> in {path}</span>}
    </>
  );
}
