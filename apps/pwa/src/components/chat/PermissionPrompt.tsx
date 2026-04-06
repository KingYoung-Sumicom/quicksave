import { useState } from 'react';
import type { ClaudeUserInputRequestPayload } from '@sumicom/quicksave-shared';

interface PermissionPromptProps {
  request: ClaudeUserInputRequestPayload;
  onRespond: (action: 'allow' | 'deny', response?: string) => void;
}

export function PermissionPrompt({ request, onRespond }: PermissionPromptProps) {
  const [textInput, setTextInput] = useState('');
  const isPermission = request.inputType === 'permission';

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-shrink-0 mt-0.5">
          {isPermission ? (
            <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-200">{request.title}</p>
          {request.toolName && (
            <p className="text-xs text-slate-400 mt-0.5 font-mono">{request.toolName}</p>
          )}
          <p className="text-xs text-slate-300 mt-1 break-all whitespace-pre-wrap">{request.message}</p>
        </div>
      </div>

      {/* Options for question type */}
      {request.options && request.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {request.options.map((opt) => (
            <button
              key={opt.key}
              onClick={() => onRespond('allow', opt.key)}
              className="text-xs px-2.5 py-1 bg-slate-700 hover:bg-slate-600 rounded-md transition-colors"
              title={opt.description}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* Text input for question type without options */}
      {!isPermission && (!request.options || request.options.length === 0) && (
        <div className="flex gap-2 mt-2">
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && textInput.trim()) {
                onRespond('allow', textInput.trim());
              }
            }}
            placeholder="Type your answer..."
            className="flex-1 bg-slate-700 rounded-md px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
            autoFocus
          />
          <button
            onClick={() => onRespond('allow', textInput.trim())}
            disabled={!textInput.trim()}
            className="text-xs px-2.5 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:text-slate-400 rounded-md transition-colors"
          >
            Send
          </button>
        </div>
      )}

      {/* Allow/Deny buttons for permission type */}
      {isPermission && (
        <div className="flex gap-2 mt-2">
          <button
            onClick={() => onRespond('allow')}
            className="flex-1 text-xs px-3 py-1.5 bg-green-600 hover:bg-green-500 rounded-md transition-colors font-medium"
          >
            Allow
          </button>
          <button
            onClick={() => onRespond('deny')}
            className="flex-1 text-xs px-3 py-1.5 bg-red-600/80 hover:bg-red-500 rounded-md transition-colors font-medium"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
