interface AskOption {
  label: string;
  description?: string;
}

interface AskQuestion {
  question: string;
  header?: string;
  options?: AskOption[];
  multiSelect?: boolean;
}

export function AskUserQuestionToolView({ input, answers }: {
  input: Record<string, unknown>;
  answers?: Record<string, string>;
}) {
  const questions = (input.questions as AskQuestion[]) || [];

  if (questions.length === 0) {
    return <span className="text-blue-400">Asking a question...</span>;
  }

  return (
    <div className="space-y-2">
      {questions.map((q, i) => {
        const answer = answers?.[q.question];
        const selectedLabels = answer ? new Set(answer.split(',').map(s => s.trim())) : null;
        // Free-text answer: doesn't match any option
        const isFreeText = selectedLabels && q.options
          && !q.options.some(o => selectedLabels.has(o.label));

        return (
          <div key={i}>
            <div className="flex items-center gap-1.5">
              <span className="text-blue-400">
                {q.header || 'Question'}
              </span>
              {q.multiSelect && (
                <span className="text-slate-500 text-xs">(multi-select)</span>
              )}
            </div>
            <div className="mt-0.5 text-slate-300">{q.question}</div>
            {q.options && q.options.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {q.options.map((opt, j) => {
                  const isSelected = selectedLabels?.has(opt.label);
                  return (
                    <span
                      key={j}
                      className={`inline-block rounded px-1.5 py-0.5 text-[10px] ${
                        selectedLabels
                          ? isSelected
                            ? 'bg-blue-500/30 text-blue-300 ring-1 ring-blue-500/40'
                            : 'bg-slate-700/40 text-slate-500 line-through'
                          : 'bg-slate-700/60 text-slate-400'
                      }`}
                      title={opt.description}
                    >
                      {opt.label}
                    </span>
                  );
                })}
                {isFreeText && (
                  <span className="inline-block bg-blue-500/30 text-blue-300 ring-1 ring-blue-500/40 rounded px-1.5 py-0.5 text-[10px]">
                    {answer}
                  </span>
                )}
              </div>
            )}
            {/* Text answer without options */}
            {!q.options && answer && (
              <span className="inline-block bg-blue-500/30 text-blue-300 ring-1 ring-blue-500/40 rounded px-1.5 py-0.5 text-[10px] mt-1">
                {answer}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
