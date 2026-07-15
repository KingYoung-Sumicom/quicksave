// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

type Fence = {
  marker: '`' | '~';
  length: number;
};

function findUnescaped(source: string, token: string, from: number): number {
  let index = source.indexOf(token, from);
  while (index >= 0) {
    let precedingBackslashes = 0;
    for (let i = index - 1; i >= 0 && source[i] === '\\'; i -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 0) return index;
    index = source.indexOf(token, index + token.length);
  }
  return -1;
}

function replacePairedDelimiters(
  source: string,
  opening: string,
  closing: string,
  replacement: string,
): string {
  let output = '';
  let cursor = 0;

  while (cursor < source.length) {
    const start = findUnescaped(source, opening, cursor);
    if (start < 0) break;
    const end = findUnescaped(source, closing, start + opening.length);
    if (end < 0) break;

    output += source.slice(cursor, start);
    output += replacement;
    output += source.slice(start + opening.length, end);
    output += replacement;
    cursor = end + closing.length;
  }

  return output + source.slice(cursor);
}

function replaceLatexDelimiters(source: string): string {
  const withDisplayMath = replacePairedDelimiters(source, '\\[', '\\]', '$$');
  return replacePairedDelimiters(withDisplayMath, '\\(', '\\)', '$');
}

function openingFence(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return {
    marker: match[1][0] as Fence['marker'],
    length: match[1].length,
  };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return !!match && match[1][0] === fence.marker && match[1].length >= fence.length;
}

/**
 * Convert the LaTeX delimiters emitted by Codex to remark-math's dollar
 * syntax. Fenced and inline code are preserved verbatim so examples do not
 * accidentally become rendered equations.
 */
export function normalizeLatexDelimiters(markdown: string): string {
  let output = '';
  let plainText = '';
  let fence: Fence | null = null;
  let inlineBackticks = 0;
  let index = 0;

  const flushPlainText = () => {
    output += replaceLatexDelimiters(plainText);
    plainText = '';
  };

  while (index < markdown.length) {
    const atLineStart = index === 0 || markdown[index - 1] === '\n';
    if (atLineStart && inlineBackticks === 0) {
      const newline = markdown.indexOf('\n', index);
      const lineEnd = newline < 0 ? markdown.length : newline;
      const line = markdown.slice(index, lineEnd);

      if (fence) {
        output += line;
        if (newline >= 0) output += '\n';
        if (closesFence(line, fence)) fence = null;
        index = newline < 0 ? markdown.length : newline + 1;
        continue;
      }

      const nextFence = openingFence(line);
      if (nextFence) {
        flushPlainText();
        output += line;
        if (newline >= 0) output += '\n';
        fence = nextFence;
        index = newline < 0 ? markdown.length : newline + 1;
        continue;
      }
    }

    if (!fence && markdown[index] === '`') {
      let runLength = 1;
      while (markdown[index + runLength] === '`') runLength += 1;

      if (inlineBackticks === 0) {
        flushPlainText();
        inlineBackticks = runLength;
      } else if (runLength === inlineBackticks) {
        inlineBackticks = 0;
      }

      output += markdown.slice(index, index + runLength);
      index += runLength;
      continue;
    }

    if (inlineBackticks === 0) {
      plainText += markdown[index];
    } else {
      output += markdown[index];
    }
    index += 1;
  }

  flushPlainText();
  return output;
}
