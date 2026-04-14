interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Remove',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-slate-800 rounded-lg w-full max-w-sm overflow-hidden">
        <div className="p-4 space-y-2">
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="text-sm text-slate-400">{message}</p>
        </div>
        <div className="flex border-t border-slate-700">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-3 text-sm text-slate-300 hover:bg-slate-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-3 text-sm text-red-400 hover:bg-slate-700 transition-colors border-l border-slate-700 font-medium"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
