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
  openingReplacement: string,
  closingReplacement = openingReplacement,
  isValidPair: (source: string, start: number, end: number) => boolean = () => true,
): string {
  let output = '';
  let cursor = 0;

  while (cursor < source.length) {
    const start = findUnescaped(source, opening, cursor);
    if (start < 0) break;
    const end = findUnescaped(source, closing, start + opening.length);
    if (end < 0) break;

    if (!isValidPair(source, start, end)) {
      output += source.slice(cursor, start + opening.length);
      cursor = start + opening.length;
      continue;
    }

    output += source.slice(cursor, start);
    output += openingReplacement;
    output += source.slice(start + opening.length, end);
    output += closingReplacement;
    cursor = end + closing.length;
  }

  return output + source.slice(cursor);
}

function lineBounds(source: string, index: number): { start: number; end: number } {
  const previousNewline = source.lastIndexOf('\n', index - 1);
  const nextNewline = source.indexOf('\n', index);
  return {
    start: previousNewline < 0 ? 0 : previousNewline + 1,
    end: nextNewline < 0 ? source.length : nextNewline,
  };
}

function isStandaloneDelimiter(source: string, index: number, tokenLength: number): boolean {
  const line = lineBounds(source, index);
  return source.slice(line.start, index).trim() === ''
    && source.slice(index + tokenLength, line.end).trim() === '';
}

function validDisplayPair(source: string, start: number, end: number): boolean {
  const content = source.slice(start + 2, end);
  if (!content.includes('\n')) return content.trim().length > 0;
  return isStandaloneDelimiter(source, start, 2)
    && isStandaloneDelimiter(source, end, 2)
    && content.trim().length > 0;
}

function validInlinePair(source: string, start: number, end: number): boolean {
  const content = source.slice(start + 2, end);
  return !content.includes('\n') && content.trim().length > 0;
}

function replaceDisplayDelimiters(source: string): string {
  let output = '';
  let cursor = 0;

  while (cursor < source.length) {
    const start = findUnescaped(source, '\\[', cursor);
    if (start < 0) break;
    const end = findUnescaped(source, '\\]', start + 2);
    if (end < 0) break;

    if (!validDisplayPair(source, start, end)) {
      output += source.slice(cursor, start + 2);
      cursor = start + 2;
      continue;
    }

    const content = source.slice(start + 2, end);
    output += source.slice(cursor, start);
    // Standalone multiline delimiters already provide their own line breaks
    // and indentation. Replacing them in place keeps both $$ markers inside
    // the same Markdown list/blockquote container.
    output += content.includes('\n') ? `$$${content}$$` : `$$\n${content}\n$$`;
    cursor = end + 2;
  }

  return output + source.slice(cursor);
}

function replaceLatexDelimiters(source: string): string {
  const withDisplayMath = replaceDisplayDelimiters(source);
  // With singleDollarTextMath disabled, paired double dollars embedded in a
  // paragraph are unambiguous inline math. Single dollars remain prose.
  return replacePairedDelimiters(withDisplayMath, '\\(', '\\)', '$$', '$$', validInlinePair);
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
