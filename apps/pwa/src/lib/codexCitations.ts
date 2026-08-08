// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
const DIRECTIVE = ':codex-file-citation{';

export function normalizeCodexFileCitations(markdown: string): string {
  let cursor = 0;
  let output = '';
  while (cursor < markdown.length) {
    const start = markdown.indexOf(DIRECTIVE, cursor);
    if (start < 0) return output + markdown.slice(cursor);
    output += markdown.slice(cursor, start);
    const end = findDirectiveEnd(markdown, start + DIRECTIVE.length);
    if (end < 0) return output + markdown.slice(start);
    const raw = markdown.slice(start, end + 1);
    const attrs = parseAttributes(markdown.slice(start + DIRECTIVE.length, end));
    output += attrs.path ? citationMarkdown(attrs.path, attrs.purpose) : raw;
    cursor = end + 1;
  }
  return output;
}

function findDirectiveEnd(value: string, start: number): number {
  let quoted = false;
  let escaped = false;
  for (let i = start; i < value.length; i++) {
    const char = value[i];
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === '}' && !quoted) {
      return i;
    }
  }
  return -1;
}

function parseAttributes(value: string): { path?: string; purpose?: string } {
  const attrs: Record<string, string> = {};
  const pattern = /([\w-]+)\s*=\s*"((?:\\.|[^"\\])*)"/g;
  for (const match of value.matchAll(pattern)) {
    attrs[match[1]] = match[2].replace(/\\(["\\])/g, '$1');
  }
  return { path: attrs.path, purpose: attrs.purpose };
}

function citationMarkdown(path: string, purpose?: string): string {
  const filename = path.split(/[\\/]/).filter(Boolean).pop() || path;
  const kind = purpose?.trim() ? titleCase(purpose.trim()) : 'File';
  const label = escapeLabel(`${kind} · ${filename}`);
  const href = encodeURI(path).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `[${label}](<${href}>)`;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, '\\$1');
}
