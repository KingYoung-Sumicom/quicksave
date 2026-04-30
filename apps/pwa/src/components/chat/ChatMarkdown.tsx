// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';
import { FilePathLink } from './FilePathLink';

/**
 * Matches a backtick-enclosed token that *looks* like a single file path
 * (with optional `:line` or `:line-line` suffix). Used to upgrade inline
 * `<code>` to a clickable `<FilePathLink>`. We only fire on whole-token
 * matches: requires at least one `/` separator, no spaces, segment chars
 * limited to typical path chars (so URL paths like `/p/:projectId/files`
 * — which embed a `:` mid-segment — fall through as plain code).
 */
const SINGLE_PATH_RE = /^(\/?[\w@.~-]+(?:\/[\w@.~-]+)+)(?::\d+(?:[-:]\d+)?)?$/;

/** Schemes we treat as "external" — open in a new tab. Anything else with
 *  no scheme is treated as a file path candidate. */
const EXTERNAL_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function ChatMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        table: ({ children }: { children?: ReactNode }) => (
          <div className="overflow-x-auto my-2">
            <table className="w-max">{children}</table>
          </div>
        ),
        code: (props) => {
          const { className, children, ...rest } = props;
          const text = typeof children === 'string'
            ? children
            : Array.isArray(children) && children.every((c) => typeof c === 'string')
              ? children.join('')
              : '';
          // Block code (fenced ``` ... ```) carries `language-*` or contains
          // newlines — leave it to the highlighter.
          const isBlock = (!!className && /\blanguage-/.test(className)) || text.includes('\n');
          if (!isBlock && text) {
            const m = text.match(SINGLE_PATH_RE);
            if (m) {
              return (
                <FilePathLink
                  path={m[1]}
                  className="inline-block align-baseline text-blue-400 hover:text-blue-300 font-bold underline transition-colors font-mono"
                >
                  {text}
                </FilePathLink>
              );
            }
          }
          return <code className={className} {...rest}>{children}</code>;
        },
        // Default `<a>` would either SPA-navigate (relative paths) or pull
        // the user out of the PWA (external URLs). Route file-shaped hrefs
        // to the same preview modal as inline code paths, and force
        // external links to open in a new tab.
        a: ({ href, children, ...rest }) => {
          const url = typeof href === 'string' ? href : '';
          if (url && !EXTERNAL_SCHEME_RE.test(url) && !url.startsWith('#')) {
            const m = url.match(SINGLE_PATH_RE);
            if (m) {
              return (
                <FilePathLink
                  path={m[1]}
                  className="inline-block align-baseline text-blue-400 hover:text-blue-300 font-bold underline transition-colors"
                >
                  {children}
                </FilePathLink>
              );
            }
          }
          return (
            <a
              {...rest}
              href={url || undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 underline transition-colors"
            >
              {children}
            </a>
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
