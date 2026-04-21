import { useState, type ReactNode } from 'react';
import { FormattedMessage } from 'react-intl';

interface ConfirmModalProps {
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  /** If provided, user must type this exact string before confirm enables. */
  confirmText?: string;
  variant?: 'default' | 'danger';
  busy?: boolean;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  confirmText,
  variant = 'default',
  busy = false,
}: ConfirmModalProps) {
  const [typed, setTyped] = useState('');
  const needsType = typeof confirmText === 'string' && confirmText.length > 0;
  const matches = !needsType || typed === confirmText;
  const disabled = busy || !matches;

  const confirmClass =
    variant === 'danger'
      ? `flex-1 px-4 py-3 text-sm font-medium border-l border-slate-700 transition-colors ${
          disabled
            ? 'text-slate-500 cursor-not-allowed'
            : 'text-red-300 bg-red-600/10 hover:bg-red-600/20'
        }`
      : `flex-1 px-4 py-3 text-sm font-medium border-l border-slate-700 transition-colors ${
          disabled
            ? 'text-slate-500 cursor-not-allowed'
            : 'text-red-400 hover:bg-slate-700'
        }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={busy ? undefined : onCancel} />
      <div className="relative bg-slate-800 rounded-lg w-full max-w-sm overflow-hidden">
        <div className="p-4 space-y-3">
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="text-sm text-slate-400 whitespace-pre-line">{message}</p>
          {needsType && (
            <div className="space-y-1.5 pt-1">
              <p className="text-xs text-slate-500">
                <FormattedMessage
                  id="common.confirm.typeHint"
                  values={{
                    text: (
                      <code className="px-1 py-0.5 bg-slate-900 rounded text-slate-300">
                        {confirmText}
                      </code>
                    ),
                  }}
                />
              </p>
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoFocus
                disabled={busy}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:border-transparent font-mono text-sm"
                placeholder={confirmText}
              />
            </div>
          )}
        </div>
        <div className="flex border-t border-slate-700">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 px-4 py-3 text-sm text-slate-300 hover:bg-slate-700 transition-colors disabled:cursor-not-allowed"
          >
            <FormattedMessage id="common.cancel" />
          </button>
          <button
            onClick={onConfirm}
            disabled={disabled}
            className={confirmClass}
          >
            {busy ? '…' : (confirmLabel ?? <FormattedMessage id="common.remove" />)}
          </button>
        </div>
      </div>
    </div>
  );
}
