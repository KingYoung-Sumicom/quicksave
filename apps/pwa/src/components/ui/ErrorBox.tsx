interface ErrorBoxProps {
  children: string;
  className?: string;
}

/**
 * Styled error message container. Replaces the duplicated
 * `bg-red-500/20 border border-red-500/50 rounded text-red-400` pattern across 10+ files.
 */
export function ErrorBox({ children, className = '' }: ErrorBoxProps) {
  return (
    <div className={`p-2 bg-red-500/20 border border-red-500/50 rounded text-sm text-red-400 ${className}`}>
      {children}
    </div>
  );
}
