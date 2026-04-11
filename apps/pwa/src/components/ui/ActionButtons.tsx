import { clsx } from 'clsx';

interface ActionButton {
  label: string;
  onClick: () => void;
  variant: 'confirm' | 'danger' | 'neutral';
  /** Extra event handlers (e.g. long-press for Allow button) */
  onMouseDown?: () => void;
  onMouseUp?: () => void;
  onMouseLeave?: () => void;
  onTouchStart?: () => void;
  onTouchEnd?: () => void;
  onTouchCancel?: () => void;
}

interface ActionButtonsProps {
  buttons: ActionButton[];
}

const VARIANT_CLASSES = {
  confirm: 'bg-green-600 hover:bg-green-500',
  danger: 'bg-red-600/80 hover:bg-red-500',
  neutral: 'bg-slate-600 hover:bg-slate-500',
};

export function ActionButtons({ buttons }: ActionButtonsProps) {
  return (
    <div className="flex gap-2 mt-2 justify-center md:max-w-xs md:mx-auto">
      {buttons.map((btn) => (
        <button
          key={btn.label}
          onClick={btn.onClick}
          onMouseDown={btn.onMouseDown}
          onMouseUp={btn.onMouseUp}
          onMouseLeave={btn.onMouseLeave}
          onTouchStart={btn.onTouchStart}
          onTouchEnd={btn.onTouchEnd}
          onTouchCancel={btn.onTouchCancel}
          className={clsx(
            'flex-1 text-xs px-3 py-1.5 rounded-md transition-colors font-medium',
            VARIANT_CLASSES[btn.variant],
          )}
        >
          {btn.label}
        </button>
      ))}
    </div>
  );
}
