export function ReadToolView({ input }: { input: Record<string, unknown> }) {
  const filePath = (input.file_path as string) || '?';
  const basename = filePath.split('/').pop() || filePath;
  const details: string[] = [];
  if (input.offset) details.push(`from L${input.offset}`);
  if (input.limit) details.push(`${input.limit} lines`);

  return (
    <>
      <span className="text-slate-400">Read</span>{' '}
      <span className="text-blue-400 font-mono" title={filePath}>{basename}</span>
      {details.length > 0 && (
        <span className="text-slate-500"> ({details.join(', ')})</span>
      )}
    </>
  );
}
