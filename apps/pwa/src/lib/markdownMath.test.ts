// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { normalizeLatexDelimiters } from './markdownMath';

describe('normalizeLatexDelimiters', () => {
  it('normalizes Codex display and inline math delimiters', () => {
    expect(normalizeLatexDelimiters(String.raw`\[A_t\]`)).toBe('$$A_t$$');
    expect(normalizeLatexDelimiters(String.raw`Value: \(A_t\)`)).toBe('Value: $A_t$');
  });

  it('preserves delimiters in fenced and inline code', () => {
    const markdown = [
      'Before \\(x\\)',
      '',
      '`\\(inline\\)`',
      '',
      '```latex',
      '\\[block\\]',
      '```',
      '',
    ].join('\n');
    const expected = [
      'Before $x$',
      '',
      '`\\(inline\\)`',
      '',
      '```latex',
      '\\[block\\]',
      '```',
      '',
    ].join('\n');

    expect(normalizeLatexDelimiters(markdown)).toBe(expected);
  });

  it('leaves escaped and unmatched delimiters unchanged', () => {
    expect(normalizeLatexDelimiters(String.raw`\\[literal\\]`)).toBe(String.raw`\\[literal\\]`);
    expect(normalizeLatexDelimiters(String.raw`\[unclosed`)).toBe(String.raw`\[unclosed`);
  });
});
