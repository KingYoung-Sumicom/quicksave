interface ChevronIconProps {
  /** Whether the chevron is in expanded/rotated state */
  expanded?: boolean;
  /** Tailwind size class (default "w-3 h-3") */
  size?: string;
  /** SVG strokeWidth (default 2) */
  strokeWidth?: number;
  className?: string;
}

/**
 * Rightward chevron that rotates 90° when expanded.
 * Replaces the identical SVG duplicated across 6+ components.
 */
export function ChevronIcon({
  expanded = false,
  size = 'w-3 h-3',
  strokeWidth = 2,
  className = '',
}: ChevronIconProps) {
  return (
    <svg
      className={`${size} shrink-0 transition-transform ${expanded ? 'rotate-90' : ''} ${className}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={strokeWidth}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}
