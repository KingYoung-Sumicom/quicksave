// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import 'highlight.js/styles/github-dark-dimmed.css';
import 'katex/dist/katex.min.css';
import { normalizeLatexDelimiters } from '../../lib/markdownMath';
import { useFilePreviewStore } from '../../stores/filePreviewStore';
import { CodeBlock } from '../ui/CodeBlock';
import { isDirectImageSource, isLocalFileUrl, LocalFileImage } from '../chat/LocalFileImage';

/** Inline-code paths and link hrefs that look like file paths route to the
 *  preview modal. Matches `ChatMarkdown`'s behaviour. */
const SINGLE_PATH_RE = /^(\/?[\w@.~-]+(?:\/[\w@.~-]+)+)(?::\d+(?:[-:]\d+)?)?$/;
const EXTERNAL_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Render a markdown file inside the file preview modal.
 *
 * Resolves relative URLs (image `src`, link `href`) against the markdown
 * file's own directory, not the project root — matches how a markdown
 * editor would render the same document. Inline images are fetched
 * through the existing `files:read` command with `allowImage: true`, then
 * rendered as `data:` URLs.
 */
export function MarkdownPreview({
  source,
  fileAbsolutePath,
  cwd,
  agentId,
}: {
  source: string;
  fileAbsolutePath: string;
  cwd: string;
  agentId: string;
}) {
  const dir = dirnameOf(fileAbsolutePath);

  return (
    <div className="px-4 py-3 text-sm text-slate-200 leading-relaxed break-words markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[[rehypeKatex, { strict: false }], rehypeHighlight]}
        urlTransform={(url, key, node) => (
          key === 'src' && node.tagName === 'img' && isLocalFileUrl(url)
            ? url
            : defaultUrlTransform(url)
        )}
        components={{
          h1: ({ children }) => <h1 className="text-2xl font-semibold mt-4 mb-3 text-slate-100 border-b border-slate-700 pb-1">{children}</h1>,
          h2: ({ children }) => <h2 className="text-xl font-semibold mt-4 mb-2 text-slate-100 border-b border-slate-700 pb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-lg font-semibold mt-3 mb-2 text-slate-100">{children}</h3>,
          h4: ({ children }) => <h4 className="text-base font-semibold mt-3 mb-1 text-slate-100">{children}</h4>,
          h5: ({ children }) => <h5 className="text-sm font-semibold mt-2 mb-1 text-slate-100">{children}</h5>,
          h6: ({ children }) => <h6 className="text-sm font-semibold mt-2 mb-1 text-slate-300">{children}</h6>,
          p: ({ children }) => <p className="my-2">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-6 my-2 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-6 my-2 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-slate-600 pl-3 my-2 text-slate-400 italic">{children}</blockquote>
          ),
          hr: () => <hr className="my-4 border-slate-700" />,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }: { children?: ReactNode }) => (
            <div className="overflow-x-auto my-2">
              <table className="w-max border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-slate-700 px-2 py-1 text-left font-semibold bg-slate-800/50">{children}</th>,
          td: ({ children }) => <td className="border border-slate-700 px-2 py-1">{children}</td>,
          a: ({ href, children, ...rest }) => {
            const url = typeof href === 'string' ? href : '';
            const linkClass = 'text-blue-400 hover:text-blue-300 underline transition-colors';
            // External — open in new tab.
            if (url && isDirectImageSource(url)) {
              return (
                <a {...rest} href={url} target="_blank" rel="noopener noreferrer" className={linkClass}>
                  {children}
                </a>
              );
            }
            // In-document anchor — let the browser handle.
            if (url.startsWith('#')) {
              return <a href={url} className={linkClass}>{children}</a>;
            }
            // Relative or absolute file path → open in preview modal.
            if (url) {
              return (
                <FileLink dir={dir} cwd={cwd} target={url} agentId={agentId}>
                  {children}
                </FileLink>
              );
            }
            return <a {...rest} className={linkClass}>{children}</a>;
          },
          // Inline-code path → clickable file link (parity with ChatMarkdown).
          code: (props) => {
            const { className, children, ...rest } = props;
            const text = typeof children === 'string'
              ? children
              : Array.isArray(children) && children.every((c) => typeof c === 'string')
                ? children.join('')
                : '';
            const isBlock = (!!className && /\blanguage-/.test(className)) || text.includes('\n');
            if (!isBlock && text) {
              const m = text.match(SINGLE_PATH_RE);
              if (m) {
                return (
                  <FileLink dir={dir} cwd={cwd} target={m[1]} agentId={agentId}>
                    {text}
                  </FileLink>
                );
              }
              return (
                <code className="px-1 py-0.5 rounded bg-slate-700/60 text-slate-100 text-[0.9em] font-mono">
                  {children}
                </code>
              );
            }
            return <code className={className} {...rest}>{children}</code>;
          },
          img: ({ src, alt, title }) => {
            const url = typeof src === 'string' ? src : '';
            // External image — render directly. The PWA already loads from
            // the network for chat content; nothing special to do here.
            if (url && EXTERNAL_SCHEME_RE.test(url)) {
              return <img src={url} alt={alt ?? ''} title={title} className="max-w-full h-auto rounded" />;
            }
            if (!url) return <span className="text-slate-500 italic">[image]</span>;
            return <LocalFileImage baseDir={dir} cwd={cwd} src={url} alt={alt ?? ''} title={title} agentId={agentId} />;
          },
        }}
      >
        {normalizeLatexDelimiters(source)}
      </ReactMarkdown>
    </div>
  );
}

/** Resolve a relative URL to a path the agent can read, then route to the
 *  preview modal. We pass `cwd` through so the modal — which itself sends
 *  another `files:read` — can use the same resolution base. */
function FileLink({
  dir,
  cwd,
  target,
  agentId,
  children,
}: {
  dir: string;
  cwd: string;
  target: string;
  agentId: string;
  children: ReactNode;
}) {
  const open = useFilePreviewStore((s) => s.open);
  const resolved = resolveAgainst(dir, target);
  return (
    <button
      type="button"
      className="text-blue-400 hover:text-blue-300 underline"
      onClick={(e) => {
        e.stopPropagation();
        // Use absolute path so the agent ignores cwd; cwd is still passed
        // for display continuity in the modal header.
        open({ cwd, path: resolved, agentId });
      }}
    >
      {children}
    </button>
  );
}

function dirnameOf(absPath: string): string {
  const i = absPath.lastIndexOf('/');
  if (i <= 0) return '/';
  return absPath.slice(0, i);
}

/** Resolve `target` against `dir`. Absolute targets are returned verbatim;
 *  relative ones are joined and `..` segments collapsed. We do this in the
 *  PWA (rather than handing the relative path to the agent with a custom
 *  cwd) so the agent's path resolution stays a single, simple rule. */
function resolveAgainst(dir: string, target: string): string {
  if (target.startsWith('/')) return collapseDots(target);
  return collapseDots(`${dir}/${target}`);
}

function collapseDots(p: string): string {
  const parts = p.split('/');
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') {
      // Preserve a leading empty segment (so the result keeps the leading "/").
      if (out.length === 0 && seg === '') out.push('');
      continue;
    }
    if (seg === '..') {
      if (out.length > 1 || (out.length === 1 && out[0] !== '')) {
        out.pop();
      }
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  return joined || '/';
}
