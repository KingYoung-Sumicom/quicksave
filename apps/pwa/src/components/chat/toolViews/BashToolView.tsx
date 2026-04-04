export function BashToolView({ input }: { input: Record<string, unknown> }) {
  const command = (input.command as string) || '?';
  const description = input.description as string | undefined;

  return (
    <div>
      <span className="text-orange-400">$</span>{' '}
      <span className="font-mono break-all">{command}</span>
      {description && (
        <div className="mt-1 text-slate-400">{description}</div>
      )}
    </div>
  );
}
