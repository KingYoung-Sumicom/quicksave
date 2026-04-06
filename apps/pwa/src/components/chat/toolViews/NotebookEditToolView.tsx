export function NotebookEditToolView({ input }: { input: Record<string, unknown> }) {
  const notebookPath = (input.notebook_path as string) || '?';
  const basename = notebookPath.split('/').pop() || notebookPath;
  const editMode = (input.edit_mode as string) || 'replace';
  const cellType = (input.cell_type as string) || '';

  return (
    <>
      <span className="text-amber-400">{editMode === 'insert' ? 'Insert' : editMode === 'delete' ? 'Delete' : 'Edit'} cell</span>{' '}
      <span className="text-blue-400 font-mono" title={notebookPath}>{basename}</span>
      {cellType && <span className="text-slate-500"> ({cellType})</span>}
    </>
  );
}
