export function FallbackToolView({ toolName, content }: { toolName?: string; content?: string }) {
  return (
    <div>
      <span className="font-mono text-yellow-400">{toolName || 'tool'}</span>
      {content && (
        <pre className="mt-1 text-slate-400 whitespace-pre-wrap break-all">
          {content}
        </pre>
      )}
    </div>
  );
}
