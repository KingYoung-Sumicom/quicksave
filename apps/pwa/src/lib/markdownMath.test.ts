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

  it('does not match inline delimiters across lines or display delimiters across prose', () => {
    const broadInline = String.raw`Before \(x
after\) stays prose.`;
    const broadDisplay = String.raw`Before \[ accidental
content that must not be swallowed
closing \] after.`;

    expect(normalizeLatexDelimiters(broadInline)).toBe(broadInline);
    expect(normalizeLatexDelimiters(broadDisplay)).toBe(broadDisplay);
  });

  it('keeps standalone multiline display math bounded to its delimiter lines', () => {
    const markdown = String.raw`固定持有期間後，可以定義：
\[
y_t=\operatorname{sign}(U_t(\text{long})-U_t(\text{short}))
\]
但後續 continuation 可能改變答案。`;
    const normalized = normalizeLatexDelimiters(markdown);

    expect(normalized).toContain('$$\ny_t=\\operatorname{sign}');
    expect(normalized).toContain('\\text{short}))\n$$');
    expect(normalized).toContain('但後續 continuation 可能改變答案。');
  });

  it('preserves display delimiter indentation inside a list item', () => {
    const markdown = [
      '1. Direction',
      String.raw`   \[`,
      String.raw`   y_t=\operatorname{sign}(U_t)`,
      String.raw`   \]`,
      '   prose after math',
    ].join('\n');

    expect(normalizeLatexDelimiters(markdown)).toBe([
      '1. Direction',
      '   $$',
      String.raw`   y_t=\operatorname{sign}(U_t)`,
      '   $$',
      '   prose after math',
    ].join('\n'));
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
