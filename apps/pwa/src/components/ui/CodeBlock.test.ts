// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { languageFromChild, textOf } from './CodeBlock';

describe('languageFromChild', () => {
  it('extracts the language token from a rehype-highlight code element', () => {
    const code = createElement('code', { className: 'hljs language-typescript' }, 'x');
    expect(languageFromChild(code)).toBe('typescript');
  });

  it('handles language tokens with symbols (c++, c#, objective-c)', () => {
    expect(languageFromChild(createElement('code', { className: 'language-c++' }))).toBe('c++');
    expect(languageFromChild(createElement('code', { className: 'language-c#' }))).toBe('c#');
    expect(languageFromChild(createElement('code', { className: 'language-objective-c' }))).toBe('objective-c');
  });

  it('returns null when there is no language class', () => {
    expect(languageFromChild(createElement('code', { className: 'hljs' }))).toBeNull();
    expect(languageFromChild(createElement('code', {}))).toBeNull();
    expect(languageFromChild('plain string')).toBeNull();
    expect(languageFromChild(null)).toBeNull();
  });
});

describe('textOf', () => {
  it('returns plain strings and numbers verbatim', () => {
    expect(textOf('hello')).toBe('hello');
    expect(textOf(42)).toBe('42');
  });

  it('flattens nested highlighter spans back to source text', () => {
    const code = createElement(
      'code',
      { className: 'language-js' },
      createElement('span', { className: 'hljs-keyword' }, 'const'),
      ' x = ',
      createElement('span', { className: 'hljs-number' }, '1'),
      ';',
    );
    expect(textOf(code)).toBe('const x = 1;');
  });

  it('ignores nullish and boolean nodes', () => {
    expect(textOf(null)).toBe('');
    expect(textOf(undefined)).toBe('');
    expect(textOf(false)).toBe('');
    expect(textOf([null, 'a', false, 'b'])).toBe('ab');
  });
});
