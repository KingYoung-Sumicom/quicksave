// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';
import { FilePathLink } from './FilePathLink';
import { CodeBlock } from '../ui/CodeBlock';

/**
 * Matches a backtick-enclosed token that *looks* like a single file path
 * (with optional `:line` or `:line-line` suffix). Used to upgrade inline
 * `<code>` to a clickable `<FilePathLink>`. We only fire on whole-token
 * matches: requires at least one `/` separator, no spaces, segment chars
 * limited to typical path chars (so URL paths like `/p/:projectId/files`
 * — which embed a `:` mid-segment — fall through as plain code).
 */
const SINGLE_PATH_RE = /^((?:\.{1,2}\/|\/)?[\w@.~-]+(?:\/[\w@.~-]+)+)(?::\d+(?:[-:]\d+)?)?$/;
const SINGLE_MARKDOWN_FILE_RE = /^((?:\.{1,2}\/)?[\w@.~-]+\.(?:md|markdown|mdx))(?::\d+(?:[-:]\d+)?)?$/i;
const ABSOLUTE_FILESYSTEM_PATH_RE = /^\/(?:home|Users|tmp|var|opt|workspace|mnt|Volumes)\//;
const APP_ROUTE_RE = /^\/(?:p|settings|pair|add)(?:\/|$)/;
const LINE_SUFFIX_RE = /:\d+(?:[-:]\d+)?$/;

/** Schemes we treat as "external" — open in a new tab. Anything else with
 *  no scheme is treated as a file path candidate. */
const EXTERNAL_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function previewPathFromMarkdownHref(href: string): string | null {
  if (!href || href.startsWith('#')) return null;
  const sameOriginPath = pathFromSameOriginUrl(href);
  if (sameOriginPath) return sameOriginPath;
  if (EXTERNAL_SCHEME_RE.test(href)) return null;
  const path = stripQueryAndHash(href);
  if (!path) return null;
  const absoluteFilesystemPath = decodeAbsoluteFilesystemPath(path);
  if (absoluteFilesystemPath) return absoluteFilesystemPath;
  const decodedPath = decodePath(path);
  if (!decodedPath || APP_ROUTE_RE.test(decodedPath)) return null;
  if (isRelativePathCandidate(decodedPath)) return stripLineSuffix(decodedPath);
  return decodedPath.match(SINGLE_PATH_RE)?.[1] ?? decodedPath.match(SINGLE_MARKDOWN_FILE_RE)?.[1] ?? null;
}

function pathFromSameOriginUrl(href: string): string | null {
  if (typeof window === 'undefined') return null;
  if (!/^(?:https?:)?\/\//i.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  return decodeAbsoluteFilesystemPath(path);
}

function decodeAbsoluteFilesystemPath(path: string): string | null {
  const decoded = decodePath(path);
  if (!decoded) return null;
  return ABSOLUTE_FILESYSTEM_PATH_RE.test(decoded) ? stripLineSuffix(decoded) : null;
}

function decodePath(path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  return decoded;
}

function isRelativePathCandidate(path: string): boolean {
  if (path.startsWith('./') || path.startsWith('../')) return path.length > 2;
  if (!path.startsWith('/') && path.includes('/')) return true;
  return SINGLE_MARKDOWN_FILE_RE.test(path);
}

function stripLineSuffix(path: string): string {
  return path.replace(LINE_SUFFIX_RE, '');
}

function stripQueryAndHash(url: string): string {
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  const idx = q < 0 ? h : h < 0 ? q : Math.min(q, h);
  return idx < 0 ? url : url.slice(0, idx);
}

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
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
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
            const previewPath = previewPathFromMarkdownHref(text);
            if (previewPath) {
              return (
                <FilePathLink
                  path={previewPath}
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
          const previewPath = previewPathFromMarkdownHref(url);
          if (previewPath) {
            return (
              <FilePathLink
                path={previewPath}
                className="inline-block align-baseline text-blue-400 hover:text-blue-300 font-bold underline transition-colors"
              >
                {children}
              </FilePathLink>
            );
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
