export function ToolResultMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-start">
      <div className="bg-slate-700/50 border border-slate-600 rounded-lg px-3 py-2 max-w-[85%] text-xs text-slate-300 overflow-hidden">
        <div className="flex items-start gap-1.5">
          <svg className="w-3 h-3 text-slate-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <pre className="flex-1 min-w-0 text-xs text-slate-400 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
            {content}
          </pre>
        </div>
      </div>
    </div>
  );
}
