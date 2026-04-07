// Tool-result accent colors (slightly dimmer than tool-call colors)
const RESULT_COLORS: Record<string, string> = {
  AskUserQuestion: 'border-blue-500/40',
  EnterPlanMode: 'border-indigo-500/40',
  ExitPlanMode: 'border-indigo-500/40',
};

import type { AskUserQuestionOutput } from './toolViews/askQuestionTypes';

function AskUserQuestionResult({ content }: { content: string }) {
  let parsed: AskUserQuestionOutput = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    // raw text fallback
    return content.trim() ? (
      <div>
        <span className="text-blue-400/70 text-[10px] uppercase tracking-wide">User answered</span>
        <div className="mt-0.5 text-slate-300">{content}</div>
      </div>
    ) : null;
  }

  const { questions = [], answers = {}, annotations } = parsed;

  if (Object.keys(answers).length === 0) return null;

  return (
    <div className="space-y-2">
      <span className="text-blue-400/70 text-[10px] uppercase tracking-wide">User answered</span>
      {questions.map((q, i) => {
        const answer = answers[q.question];
        const annotation = annotations?.[q.question];
        if (!answer) return null;

        // Find which option(s) the user selected
        const selectedLabels = answer.split(',').map(s => s.trim());

        return (
          <div key={i}>
            {q.header && (
              <div className="text-slate-500 text-[10px]">{q.header}</div>
            )}
            <div className="flex flex-wrap gap-1 mt-0.5">
              {q.options?.map((opt, j) => {
                const isSelected = selectedLabels.includes(opt.label);
                return (
                  <span
                    key={j}
                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] ${
                      isSelected
                        ? 'bg-blue-500/30 text-blue-300 ring-1 ring-blue-500/40'
                        : 'bg-slate-700/40 text-slate-500 line-through'
                    }`}
                    title={opt.description}
                  >
                    {opt.label}
                  </span>
                );
              })}
              {/* Show raw answer if it doesn't match any option (user typed custom "Other") */}
              {q.options && !q.options.some(o => selectedLabels.includes(o.label)) && (
                <span className="inline-block bg-blue-500/30 text-blue-300 ring-1 ring-blue-500/40 rounded px-1.5 py-0.5 text-[10px]">
                  {answer}
                </span>
              )}
              {/* If no options array, show raw answer text */}
              {!q.options && (
                <span className="text-slate-300">{answer}</span>
              )}
            </div>
            {annotation?.notes && (
              <div className="text-slate-500 text-[10px] mt-0.5 italic">{annotation.notes}</div>
            )}
          </div>
        );
      })}
      {/* Fallback: answers that don't match any question in the echo */}
      {Object.entries(answers)
        .filter(([qText]) => !questions.some(q => q.question === qText))
        .map(([qText, answer], i) => (
          <div key={`extra-${i}`}>
            <div className="text-slate-500 text-[10px] truncate">{qText}</div>
            <span className="inline-block bg-blue-500/30 text-blue-300 ring-1 ring-blue-500/40 rounded px-1.5 py-0.5 text-[10px] mt-0.5">
              {answer}
            </span>
          </div>
        ))}
    </div>
  );
}

export function ToolResultMessage({ content, toolResultOf }: {
  content: string;
  toolResultOf?: string;
}) {
  const accentColor = toolResultOf ? (RESULT_COLORS[toolResultOf] || 'border-green-500/40') : 'border-green-500/40';

  // AskUserQuestion: show selected options
  if (toolResultOf === 'AskUserQuestion' && content.trim()) {
    return (
      <div className="flex justify-start">
        <div className={`bg-slate-800/40 border-l-2 ${accentColor} rounded-r-lg pl-2.5 pr-3 py-1.5 max-w-[90%] text-xs text-slate-400 overflow-hidden`}>
          <AskUserQuestionResult content={content} />
        </div>
      </div>
    );
  }

  // Default result: preformatted content
  if (!content.trim()) return null;

  return (
    <div className="flex justify-start">
      <div className={`bg-slate-800/40 border-l-2 ${accentColor} rounded-r-lg pl-2.5 pr-3 py-1.5 max-w-[90%] text-xs text-slate-400 overflow-hidden`}>
        <pre className="min-w-0 whitespace-pre-wrap break-all">
          {content}
        </pre>
      </div>
    </div>
  );
}
