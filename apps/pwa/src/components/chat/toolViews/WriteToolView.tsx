import type { ReactNode } from 'react';

export function WriteToolView({ input, headerSuffix }: { input: Record<string, unknown>; headerSuffix?: ReactNode }) {
  const filePath = (input.file_path as string) || '?';
  const basename = filePath.split('/').pop() || filePath;
  const content = (input.content as string) || '';
  const lines = content.split('\n').length;

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-green-400 shrink-0">Write</span>{' '}
      <span className="text-blue-400 font-mono truncate" title={filePath}>{basename}</span>
      <span className="text-slate-500 shrink-0"> ({lines} lines)</span>
      {headerSuffix}
    </div>
  );
}
