export function EnterPlanModeToolView() {
  return <span className="text-indigo-400">Entering plan mode</span>;
}

interface AllowedPrompt {
  tool: string;
  prompt: string;
}

export function ExitPlanModeToolView({ input }: { input: Record<string, unknown> }) {
  const allowedPrompts = (input.allowedPrompts as AllowedPrompt[]) || [];

  return (
    <div>
      <span className="text-indigo-400">Plan ready for review</span>
      {allowedPrompts.length > 0 && (
        <div className="mt-1.5 space-y-1">
          <span className="text-slate-500 text-[10px] uppercase tracking-wide">Requested permissions</span>
          {allowedPrompts.map((p, i) => (
            <div key={i} className="flex items-start gap-1.5 text-slate-300">
              <span className="text-amber-400/70 text-[10px] font-mono mt-px shrink-0">{p.tool}</span>
              <span>{p.prompt}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
