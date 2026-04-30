// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';
import { useClaudeStore } from '../../stores/claudeStore';
import { useFilePreviewStore } from '../../stores/filePreviewStore';

interface FilePathLinkProps {
  /** Absolute or relative path. Relative paths resolve against the active session's cwd. */
  path: string;
  /** What to show — defaults to the path basename. */
  children?: ReactNode;
  /** Tailwind classes layered on top of the always-applied UA reset. */
  className?: string;
  /** Tooltip / hover title — defaults to the full path. */
  title?: string;
}

/**
 * UA-reset for the underlying `<button>` element. Strips browser-default
 * padding/border/font/background so visual treatment comes purely from
 * `className`. `text-left` is part of the reset because UA buttons
 * default to `text-align: center`, which would centre wrapped or
 * truncated path text — wrong for a file path. We do NOT lock the
 * display mode here; the default look + each call-site pick that.
 */
const RESET = 'appearance-none bg-transparent border-0 p-0 m-0 cursor-pointer text-inherit text-left';

/** Default visual: inline-block, blue, bold, underline (used by tool-call
 *  headers). Linkify call-sites pass their own equivalent without
 *  `truncate` so paths inside `<pre>` output don't get clipped. */
const DEFAULT_LOOK = 'inline-block align-baseline text-blue-400 hover:text-blue-300 font-bold underline transition-colors font-mono truncate max-w-full';

/**
 * Inline clickable file path. Pops the global `FilePreviewModal` for the
 * referenced file, using the active session's cwd as the resolution base
 * for relative paths.
 *
 * Use this everywhere a card surfaces a file path — Read/Write/Edit tool
 * headers, Bash output paths, inline code in assistant markdown, etc.
 */
export function FilePathLink({ path, children, className, title }: FilePathLinkProps) {
  const cwd = useClaudeStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessions[id]?.cwd ?? '' : '';
  });
  const openPreview = useFilePreviewStore((s) => s.open);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openPreview({ cwd, path });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={title ?? path}
      className={`${RESET} ${className ?? DEFAULT_LOOK}`}
    >
      {children ?? path.split('/').pop() ?? path}
    </button>
  );
}
