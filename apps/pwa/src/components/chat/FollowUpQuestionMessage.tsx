// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';

interface Props {
  question: string;
  options?: readonly string[];
  allowFreeText?: boolean;
  answer?: string;
  dismissed?: boolean;
  /** Resolves Codex's pending non-blocking request_user_input call. */
  onRespond?: (response: string) => void;
  /** Resolves the request with no selected answer. */
  onDismiss?: () => void;
}

/**
 * A non-blocking question from Codex. It remains optional to the model's
 * current work, but a reply still resolves the app-server request rather than
 * sending a new user turn.
 */
export function FollowUpQuestionMessage({ question, options, allowFreeText, answer, dismissed, onRespond, onDismiss }: Props) {
  const [textInput, setTextInput] = useState('');
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [sentResponse, setSentResponse] = useState<string | null>(null);
  const [dismissedLocally, setDismissedLocally] = useState(false);

  const sendResponse = () => {
    const response = selectedOption ?? textInput;
    const trimmed = response.trim();
    if (!trimmed || sentResponse !== null || dismissed || dismissedLocally || !onRespond) return;
    setSentResponse(trimmed);
    onRespond(trimmed);
  };

  const dismiss = () => {
    if (sentResponse !== null || dismissed || dismissedLocally || !onDismiss) return;
    setDismissedLocally(true);
    onDismiss();
  };

  const hasOptions = !!options?.length;
  const showsFreeText = !hasOptions || allowFreeText;
  const resolved = answer !== undefined || dismissed;

  return (
    <section className="mr-auto max-w-prose rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm text-slate-200">
      <p className="text-[10px] font-medium uppercase tracking-wide text-blue-300/70">Optional follow-up</p>
      <p className="mt-1 font-medium text-blue-100 whitespace-pre-wrap">{question}</p>

      {resolved ? (
        <p className="mt-2 text-xs text-blue-100">
          {answer !== undefined ? `Answered: ${answer}` : 'Dismissed'}
        </p>
      ) : hasOptions ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {options!.map((option) => (
            <button
              key={option}
              type="button"
              disabled={sentResponse !== null || dismissed || dismissedLocally || !onRespond}
              aria-pressed={selectedOption === option}
              onClick={() => {
                setSelectedOption(option);
                setTextInput('');
              }}
              className={`rounded-md px-2.5 py-1 text-xs text-slate-100 transition-colors disabled:cursor-not-allowed disabled:bg-slate-700/50 disabled:text-slate-400 ${
                selectedOption === option
                  ? 'bg-blue-600 ring-1 ring-blue-300'
                  : 'bg-slate-700 hover:bg-slate-600'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}

      {!resolved && showsFreeText ? (
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={textInput}
            disabled={sentResponse !== null || dismissed || dismissedLocally || !onRespond}
            onChange={(event) => {
              setTextInput(event.target.value);
              if (event.target.value) setSelectedOption(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) sendResponse();
            }}
            placeholder="Reply if useful…"
            className="min-w-0 flex-1 rounded-md bg-slate-800/80 px-2.5 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:text-slate-400"
          />
          <button
            type="button"
            disabled={sentResponse !== null || dismissed || dismissedLocally || !onRespond || !(selectedOption ?? textInput).trim()}
            onClick={sendResponse}
            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {sentResponse !== null ? 'Sent' : 'Send'}
          </button>
        </div>
      ) : null}

      {!resolved && hasOptions && !showsFreeText ? (
        <button
          type="button"
          disabled={sentResponse !== null || dismissed || dismissedLocally || !onRespond || !selectedOption}
          onClick={sendResponse}
          className="mt-2 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {sentResponse !== null ? 'Sent' : 'Send'}
        </button>
      ) : null}

      {!resolved && onDismiss ? (
        <button
          type="button"
          disabled={sentResponse !== null || dismissed || dismissedLocally}
          onClick={dismiss}
          className="mt-2 text-xs text-blue-200/70 underline-offset-2 hover:text-blue-100 hover:underline disabled:cursor-not-allowed disabled:text-slate-500"
        >
          {dismissedLocally ? 'Dismissed' : 'Dismiss'}
        </button>
      ) : null}
    </section>
  );
}
