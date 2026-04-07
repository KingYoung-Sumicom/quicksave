import { useState, type ComponentType, type ReactNode } from 'react';
import { parseToolUseError } from './ToolResultMessage';
import type { ClaudeUserInputRequestPayload } from '@sumicom/quicksave-shared';
import { ReadToolView } from './toolViews/ReadToolView';
import { EditToolView } from './toolViews/EditToolView';
import { WriteToolView } from './toolViews/WriteToolView';
import { BashToolView } from './toolViews/BashToolView';
import { GrepToolView } from './toolViews/GrepToolView';
import { GlobToolView } from './toolViews/GlobToolView';
import { WebFetchToolView } from './toolViews/WebFetchToolView';
import { WebSearchToolView } from './toolViews/WebSearchToolView';
import { SkillToolView } from './toolViews/SkillToolView';
import { AgentToolView } from './toolViews/AgentToolView';
import { TodoWriteToolView } from './toolViews/TodoWriteToolView';
import { NotebookEditToolView } from './toolViews/NotebookEditToolView';
import { AskUserQuestionToolView } from './toolViews/AskUserQuestionToolView';
import { EnterPlanModeToolView, ExitPlanModeToolView, ExitPlanModeInteractiveView } from './toolViews/PlanModeToolView';
import { ToolSearchToolView } from './toolViews/ToolSearchToolView';
import { FallbackToolView } from './toolViews/FallbackToolView';

type ToolViewProps = { input: Record<string, unknown>; headerSuffix?: ReactNode };
const TOOL_VIEWS: Record<string, ComponentType<ToolViewProps>> = {
  Read: ReadToolView,
  Edit: EditToolView,
  Write: WriteToolView,
  Bash: BashToolView,
  Grep: GrepToolView,
  Glob: GlobToolView,
  WebFetch: WebFetchToolView,
  WebSearch: WebSearchToolView,
  Skill: SkillToolView,
  Agent: AgentToolView,
  TodoWrite: TodoWriteToolView,
  NotebookEdit: NotebookEditToolView,
  AskUserQuestion: AskUserQuestionToolView,
  EnterPlanMode: EnterPlanModeToolView as ComponentType<ToolViewProps>,
  ExitPlanMode: ExitPlanModeToolView,
  ToolSearch: ToolSearchToolView,
};

// Tool-specific icon colors for the left accent bar
const TOOL_COLORS: Record<string, string> = {
  Read: 'border-blue-500/60',
  Edit: 'border-yellow-500/60',
  Write: 'border-green-500/60',
  Bash: 'border-orange-500/60',
  Grep: 'border-purple-500/60',
  Glob: 'border-purple-500/60',
  WebFetch: 'border-cyan-500/60',
  WebSearch: 'border-cyan-500/60',
  Skill: 'border-indigo-500/60',
  Agent: 'border-violet-500/60',
  TodoWrite: 'border-teal-500/60',
  NotebookEdit: 'border-amber-500/60',
  AskUserQuestion: 'border-blue-500/60',
  EnterPlanMode: 'border-indigo-500/60',
  ExitPlanMode: 'border-indigo-500/60',
  ToolSearch: 'border-pink-500/60',
};

function InlinePermissionActions({ request, onRespond }: {
  request: ClaudeUserInputRequestPayload;
  onRespond: (action: 'allow' | 'deny', response?: string) => void;
}) {
  return (
    <div className="mt-2 pt-2 border-t border-amber-500/20">
      <p className="text-sm text-amber-400/80 mb-2">{request.title}</p>
      <div className="flex gap-2">
        <button
          onClick={() => onRespond('allow')}
          className="flex-1 text-sm px-3 py-1.5 bg-green-600/80 hover:bg-green-500 rounded-lg transition-colors font-medium"
        >
          Allow
        </button>
        <button
          onClick={() => onRespond('deny')}
          className="flex-1 text-sm px-3 py-1.5 bg-red-600/60 hover:bg-red-500 rounded-lg transition-colors font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

/** Shared option row — radio (single) or checkbox (multi). */
function OptionRow({ label, description, isSelected, isLocked, isMulti, onClick }: {
  label: string;
  description?: string;
  isSelected: boolean;
  isLocked: boolean;
  isMulti: boolean;
  onClick?: () => void;
}) {
  const base = isLocked
    ? isSelected
      ? 'bg-blue-600/30 border-blue-500/50 ring-1 ring-blue-500/30'
      : 'bg-slate-800/40 border-slate-700/40 opacity-40'
    : isSelected
      ? 'bg-blue-600/40 border-blue-500/60 ring-1 ring-blue-500/30'
      : 'bg-slate-700/80 border-slate-600/50 hover:bg-blue-600/30 hover:border-blue-500/40';

  return (
    <button
      onClick={onClick}
      disabled={isLocked}
      className={`w-full text-left text-sm px-3 py-2 rounded-lg transition-colors border ${base} ${isLocked ? 'cursor-default' : ''}`}
    >
      <span className="flex items-center gap-2">
        <span className={`shrink-0 w-4 h-4 ${isMulti ? 'rounded' : 'rounded-full'} border flex items-center justify-center text-[10px] ${
          isSelected ? 'bg-blue-500 border-blue-400 text-white' : 'border-slate-500'
        }`}>
          {isSelected && (isMulti ? '✓' : '●')}
        </span>
        <span>
          <span className="font-medium">{label}</span>
          {description && (
            <span className="block text-xs text-slate-400 mt-0.5">{description}</span>
          )}
        </span>
      </span>
    </button>
  );
}

/**
 * Single-question block with options or text input.
 * For multiSelect: checkboxes that accumulate selections.
 * For single-select: clicking an option immediately returns the answer.
 * When locked: shows all options with selected highlighted, all disabled.
 */
function QuestionBlock({ question, header, options, multiSelect, lockedAnswer, hideSubmit, onAnswer, onSelectionChange }: {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  lockedAnswer?: string;
  hideSubmit?: boolean;
  onAnswer: (answer: string) => void;
  onSelectionChange?: (answer: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [textInput, setTextInput] = useState('');
  const [showTextInput, setShowTextInput] = useState(false);

  const getCurrentAnswer = (sel: Set<string>, text: string, showText: boolean) => {
    if (showText && text.trim()) {
      return multiSelect ? [...sel, text.trim()].join(', ') : text.trim();
    }
    return [...sel].join(', ');
  };

  const isLocked = lockedAnswer !== undefined;
  const lockedLabels = lockedAnswer ? new Set(lockedAnswer.split(',').map(s => s.trim())) : new Set<string>();
  // Free-text answer: answer doesn't match any option
  const isFreeTextAnswer = isLocked && options && options.length > 0
    && !options.some(o => lockedLabels.has(o.label));

  const toggleOption = (label: string) => {
    setSelected((prev) => {
      let next: Set<string>;
      if (multiSelect) {
        next = new Set(prev);
        if (next.has(label)) next.delete(label);
        else next.add(label);
      } else {
        // Single-select: deselect Other when picking a normal option
        setShowTextInput(false);
        next = new Set([label]);
      }
      onSelectionChange?.(getCurrentAnswer(next, textInput, false));
      return next;
    });
  };

  return (
    <div>
      {header && (
        <span className="text-blue-400/70 text-[10px] uppercase tracking-wide">{header}</span>
      )}
      <p className={`text-sm text-blue-300 font-medium mb-1.5 ${isLocked ? 'opacity-70' : ''}`}>{question}</p>

      {options && options.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {options.map((opt) => (
            <OptionRow
              key={opt.label}
              label={opt.label}
              description={opt.description}
              isMulti={!!multiSelect}
              isLocked={isLocked}
              isSelected={isLocked ? lockedLabels.has(opt.label) : selected.has(opt.label)}
              onClick={isLocked ? undefined : () => toggleOption(opt.label)}
            />
          ))}
          {/* Locked free-text answer that didn't match any option */}
          {isFreeTextAnswer && (
            <span className="inline-block bg-blue-500/30 text-blue-300 ring-1 ring-blue-500/40 rounded px-2 py-1 text-xs">
              {lockedAnswer}
            </span>
          )}
          {/* "Other" option — label + textbox always visible, click anywhere to select */}
          {!isLocked && (() => {
            const isOtherSelected = showTextInput;
            const selectOther = () => {
              if (!isOtherSelected) {
                setShowTextInput(true);
                if (!multiSelect) setSelected(new Set());
                onSelectionChange?.(getCurrentAnswer(new Set(), textInput, true));
              }
            };
            const base = isOtherSelected
              ? 'bg-blue-600/40 border-blue-500/60 ring-1 ring-blue-500/30'
              : 'bg-slate-700/80 border-slate-600/50 hover:bg-blue-600/30 hover:border-blue-500/40';
            return (
              <div
                onClick={selectOther}
                className={`w-full text-left text-sm px-3 py-2 rounded-lg transition-colors border cursor-pointer ${base}`}
              >
                <span className="flex items-center gap-2">
                  <span className={`shrink-0 w-4 h-4 ${multiSelect ? 'rounded' : 'rounded-full'} border flex items-center justify-center text-[10px] ${
                    isOtherSelected ? 'bg-blue-500 border-blue-400 text-white' : 'border-slate-500'
                  }`}>
                    {isOtherSelected && (multiSelect ? '✓' : '●')}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="font-medium">Other</span>
                    <input
                      type="text"
                      value={textInput}
                      onChange={(e) => {
                        setTextInput(e.target.value);
                        if (!isOtherSelected) selectOther();
                        onSelectionChange?.(getCurrentAnswer(selected, e.target.value, true));
                      }}
                      onFocus={selectOther}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="Type your answer..."
                      className="block w-full mt-1 bg-slate-800/60 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-slate-600"
                    />
                  </span>
                </span>
              </div>
            );
          })()}
          {/* Submit button (hidden when parent manages submit) */}
          {!isLocked && !hideSubmit && (
            <button
              onClick={() => onAnswer(getCurrentAnswer(selected, textInput, showTextInput))}
              disabled={selected.size === 0 && !(showTextInput && textInput.trim())}
              className="mt-1 text-sm px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:text-slate-400 rounded-lg transition-colors font-medium"
            >
              {multiSelect ? `Confirm (${selected.size + (showTextInput && textInput.trim() ? 1 : 0)} selected)` : 'Confirm'}
            </button>
          )}
        </div>
      ) : (
        isLocked ? (
          <span className="inline-block bg-blue-500/30 text-blue-300 ring-1 ring-blue-500/40 rounded px-2 py-1 text-xs">
            {lockedAnswer}
          </span>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && textInput.trim()) onAnswer(textInput.trim());
              }}
              placeholder="Type your answer..."
              className="flex-1 bg-slate-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              autoFocus
            />
            <button
              onClick={() => onAnswer(textInput.trim())}
              disabled={!textInput.trim()}
              className="text-sm px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:text-slate-400 rounded-lg transition-colors"
            >
              Send
            </button>
          </div>
        )
      )}
    </div>
  );
}

/**
 * Interactive AskUserQuestion view — all questions shown at once,
 * answered questions locked with full options visible (selected highlighted).
 * Supports multi-select checkboxes and free-text "Other" input.
 */
function InteractiveQuestionView({ request, parsedInput, onRespond }: {
  request: ClaudeUserInputRequestPayload;
  parsedInput: Record<string, unknown>;
  onRespond: (action: 'allow' | 'deny', response?: string) => void;
}) {
  const questions = (parsedInput.questions as Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>) || [];

  // Live selections (not yet submitted) — separate from locked (submitted) answers
  const [selections, setSelections] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const effectiveQuestions = questions.length > 0
    ? questions
    : [{
        question: request.title || 'Question from Claude',
        header: undefined as string | undefined,
        options: request.options?.map((o) => ({ label: o.label, description: o.description })),
        multiSelect: false,
      }];

  const isMultiPage = effectiveQuestions.length > 1;

  const handleAnswer = (qIndex: number, answer: string) => {
    const updated = { ...selections, [qIndex]: answer };
    setSelections(updated);

    // Single-question: submit immediately from QuestionBlock's own Confirm
    if (!isMultiPage) {
      setSubmitted(true);
      onRespond('allow', updated[0]);
    }
  };

  const handleSubmitAll = () => {
    setSubmitted(true);
    const response = effectiveQuestions.map((_q, i) => selections[i] ?? '').join('\n');
    onRespond('allow', response);
  };

  const allAnswered = Object.keys(selections).length >= effectiveQuestions.length
    && Object.values(selections).every((a) => a.trim() !== '');

  return (
    <div className="space-y-3">
      {request.message && (
        <p className="text-xs text-slate-400">{request.message}</p>
      )}
      {effectiveQuestions.map((q, i) => (
        <QuestionBlock
          key={i}
          question={q.question}
          header={q.header}
          options={q.options}
          multiSelect={q.multiSelect}
          lockedAnswer={submitted ? selections[i] : undefined}
          hideSubmit={isMultiPage}
          onAnswer={(answer) => handleAnswer(i, answer)}
          onSelectionChange={isMultiPage ? (answer) => setSelections((prev) => ({ ...prev, [i]: answer })) : undefined}
        />
      ))}
      {isMultiPage && (
        <button
          onClick={handleSubmitAll}
          disabled={!allAnswered}
          className="w-full text-sm px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:text-slate-400 rounded-lg transition-colors font-medium"
        >
          Submit All
        </button>
      )}
    </div>
  );
}

const INLINE_RESULT_TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);
const INLINE_RESULT_BORDER: Record<string, string> = {
  Read:  'border-blue-500/20',
  Write: 'border-green-500/20',
  Edit:  'border-yellow-500/20',
  Bash:  'border-orange-500/20',
  Glob:  'border-purple-500/20',
  Grep:  'border-purple-500/20',
};

// Tools where result text is implied by the tool call itself (suppress unless error)
const TOOLS_SUPPRESS_RESULT_CONTENT = new Set(['Edit']);

function InlineToolResult({ content, toolName, suppressContent, expanded }: {
  content: string;
  toolName?: string;
  suppressContent?: boolean;
  expanded: boolean;
}) {
  const borderColor = INLINE_RESULT_BORDER[toolName ?? ''] ?? 'border-slate-500/20';

  if (!content.trim()) return null;

  const toolError = parseToolUseError(content);
  if (toolError !== null || suppressContent) {
    if (toolError === null) return null; // suppressed and no error
    return (
      <div className="mt-1.5 border-t border-red-500/30">
        <div className="pt-1.5 flex items-start gap-1.5">
          <span className="text-red-400/70 text-[10px] uppercase tracking-wide shrink-0 mt-px">Error</span>
          <span className="text-red-300 text-xs">{toolError || 'Tool call failed'}</span>
        </div>
      </div>
    );
  }

  if (!expanded) return null;

  return (
    <div className={`mt-1.5 border-t ${borderColor}`}>
      <pre className="mt-1 min-w-0 whitespace-pre-wrap break-all text-slate-400 overflow-x-auto pt-1">
        {content}
      </pre>
    </div>
  );
}

export function ToolCallMessage({ toolName, toolInput, content, toolResultContent, pendingInputRequest, onRespond }: {
  toolName?: string;
  toolInput?: string;
  content: string;
  toolResultContent?: string;
  pendingInputRequest?: ClaudeUserInputRequestPayload;
  onRespond?: (action: 'allow' | 'deny', response?: string) => void;
}) {
  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(toolInput || content || '{}');
  } catch {
    // fallback to empty
  }

  // Parse tool result for views that need answer data (e.g. AskUserQuestion)
  let parsedResult: Record<string, unknown> | undefined;
  if (toolResultContent) {
    try { parsedResult = JSON.parse(toolResultContent); } catch { /* ignore */ }
  }

  const hasPending = !!pendingInputRequest;

  // AskUserQuestion with pending request: render unified interactive view
  if (toolName === 'AskUserQuestion' && hasPending && pendingInputRequest.inputType === 'question' && onRespond) {
    return (
      <div className="flex justify-start">
        <div className="bg-slate-800/60 border-l-2 border-blue-500/80 rounded-r-lg pl-2.5 pr-3 py-1.5 w-full text-xs text-slate-300 overflow-hidden">
          <InteractiveQuestionView
            request={pendingInputRequest}
            parsedInput={parsedInput}
            onRespond={onRespond}
          />
        </div>
      </div>
    );
  }

  // ExitPlanMode with pending request: render plan review with approve/reject
  // Plan text is in the INPUT (input.plan), not the output
  if (toolName === 'ExitPlanMode' && hasPending && onRespond) {
    return (
      <div className="flex justify-start">
        <div className="bg-slate-800/60 border-l-2 border-indigo-500/80 rounded-r-lg pl-2.5 pr-3 py-1.5 w-full text-xs text-slate-300 overflow-hidden">
          <ExitPlanModeInteractiveView input={parsedInput} plan={parsedInput.plan as string} onRespond={onRespond} />
        </div>
      </div>
    );
  }

  const ToolView = toolName ? TOOL_VIEWS[toolName] : undefined;
  const accentColor = hasPending
    ? 'border-amber-500/80'
    : toolName ? (TOOL_COLORS[toolName] || 'border-slate-500/60') : 'border-slate-500/60';

  // Inline result expand state (lifted so chevron can live in header row)
  const isInlineResultTool = !!(toolName && INLINE_RESULT_TOOLS.has(toolName) && toolResultContent);
  const resultContent = toolResultContent || '';
  const resultLineCount = resultContent.trimEnd().split('\n').length;
  const resultAutoExpand = !resultContent.trim() || resultLineCount <= 2;
  const resultSuppressed = toolName ? TOOLS_SUPPRESS_RESULT_CONTENT.has(toolName) : false;
  const resultError = isInlineResultTool ? parseToolUseError(resultContent) : null;
  const showChevron = isInlineResultTool && !resultAutoExpand && resultError === null && !resultSuppressed;
  const [resultExpanded, setResultExpanded] = useState(false);

  const chevronButton: ReactNode = showChevron ? (
    <button
      onClick={() => setResultExpanded(v => !v)}
      className="flex items-center gap-1 shrink-0 bg-slate-700/60 hover:bg-slate-600/60 text-slate-400 hover:text-slate-300 rounded px-1.5 py-0.5 transition-colors"
    >
      <svg
        className={`w-2.5 h-2.5 transition-transform ${resultExpanded ? 'rotate-90' : ''}`}
        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
      <span className="text-[10px]">{resultLineCount} lines</span>
    </button>
  ) : null;

  return (
    <div className="flex justify-start">
      <div className={`bg-slate-800/60 border-l-2 ${accentColor} rounded-r-lg pl-2.5 pr-3 py-1.5 w-full text-xs text-slate-300 overflow-hidden`}>
        <div className="min-w-0">
          {toolName === 'AskUserQuestion'
            ? <AskUserQuestionToolView input={parsedInput} answers={(parsedResult as any)?.answers} />
            : toolName === 'ExitPlanMode'
              ? <ExitPlanModeToolView input={parsedInput} plan={parsedInput.plan as string} />
              : ToolView
                ? <ToolView input={parsedInput} headerSuffix={isInlineResultTool ? chevronButton : undefined} />
                : <FallbackToolView toolName={toolName} content={toolInput || content} />}
        </div>
        {isInlineResultTool && (
          <InlineToolResult
            content={resultContent}
            toolName={toolName}
            suppressContent={resultSuppressed}
            expanded={resultAutoExpand || resultExpanded}
          />
        )}
        {pendingInputRequest && onRespond && pendingInputRequest.inputType === 'permission' && (
          <InlinePermissionActions request={pendingInputRequest} onRespond={onRespond} />
        )}
      </div>
    </div>
  );
}
