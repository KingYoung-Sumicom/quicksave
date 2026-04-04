export function EditToolView({ input }: { input: Record<string, unknown> }) {
  const filePath = (input.file_path as string) || '?';
  const basename = filePath.split('/').pop() || filePath;
  const oldStr = (input.old_string as string) || '';
  const newStr = (input.new_string as string) || '';
  const oldLines = oldStr ? oldStr.split('\n').slice(0, 8) : [];
  const newLines = newStr ? newStr.split('\n').slice(0, 8) : [];
  const oldTruncated = oldStr.split('\n').length > 8;
  const newTruncated = newStr.split('\n').length > 8;

  return (
    <div>
      <div>
        <span className="text-yellow-400">Edit</span>{' '}
        <span className="text-blue-400 font-mono" title={filePath}>{basename}</span>
        <span className="text-slate-500"> (-{oldStr.length}/+{newStr.length})</span>
      </div>
      {(oldStr || newStr) && (
        <div className="mt-1.5 font-mono overflow-x-auto">
          {oldLines.length > 0 && (
            <div className="bg-red-500/10 rounded-t px-2 py-1">
              {oldLines.map((line, i) => (
                <div key={i} className="text-red-400 whitespace-pre-wrap break-all">- {line}</div>
              ))}
              {oldTruncated && <div className="text-red-400/50">  ...</div>}
            </div>
          )}
          {newLines.length > 0 && (
            <div className="bg-green-500/10 rounded-b px-2 py-1">
              {newLines.map((line, i) => (
                <div key={i} className="text-green-400 whitespace-pre-wrap break-all">+ {line}</div>
              ))}
              {newTruncated && <div className="text-green-400/50">  ...</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
