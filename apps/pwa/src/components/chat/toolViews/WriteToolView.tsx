export function WriteToolView({ input }: { input: Record<string, unknown> }) {
  const filePath = (input.file_path as string) || '?';
  const basename = filePath.split('/').pop() || filePath;
  const content = (input.content as string) || '';
  const lines = content.split('\n').length;

  return (
    <>
      <span className="text-green-400">Write</span>{' '}
      <span className="text-blue-400 font-mono" title={filePath}>{basename}</span>
      <span className="text-slate-500"> ({lines} lines)</span>
    </>
  );
}
