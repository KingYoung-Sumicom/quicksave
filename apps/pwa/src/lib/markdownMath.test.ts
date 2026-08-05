// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { normalizeLatexDelimiters } from './markdownMath';

describe('normalizeLatexDelimiters', () => {
  it('normalizes Codex display and inline math delimiters', () => {
    expect(normalizeLatexDelimiters(String.raw`\[A_t\]`)).toBe('$$\nA_t\n$$');
    expect(normalizeLatexDelimiters(String.raw`Value: \(A_t\)`)).toBe('Value: $$A_t$$');
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
      'Before $$x$$',
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

  it('leaves every single-dollar use untouched', () => {
    const prose = 'Prices $166.99 and $1,299; shell $HOME; literal $word$; equation-like $2 + 2 = 4$.';
    expect(normalizeLatexDelimiters(prose)).toBe(prose);
  });

  it('preserves currency examples inside code', () => {
    expect(normalizeLatexDelimiters('`$166.99`\n```text\n$286.98\n```'))
      .toBe('`$166.99`\n```text\n$286.98\n```');
  });
});
