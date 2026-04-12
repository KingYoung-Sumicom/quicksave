interface SpinnerProps {
  /** Tailwind size class (default "w-4 h-4") */
  size?: string;
  /** Tailwind border color (default "border-slate-400") — the visible arc color */
  color?: string;
  /** Tailwind border width class (default "border-2") */
  borderWidth?: string;
  className?: string;
}

/**
 * Border-based loading spinner. Replaces the duplicated
 * `border-*-transparent rounded-full animate-spin` pattern across 12+ files.
 */
export function Spinner({
  size = 'w-4 h-4',
  color = 'border-slate-400',
  borderWidth = 'border-2',
  className = '',
}: SpinnerProps) {
  return (
    <span
      className={`inline-block ${size} ${borderWidth} ${color} border-t-transparent rounded-full animate-spin ${className}`}
    />
  );
}
