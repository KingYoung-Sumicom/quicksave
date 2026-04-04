export function SystemMessage({ content }: { content: string }) {
  return (
    <div className="text-center text-xs text-slate-500 py-1">
      {content}
    </div>
  );
}
