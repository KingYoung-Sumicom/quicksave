// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { previewPathFromMarkdownHref } from './ChatMarkdown';

describe('previewPathFromMarkdownHref', () => {
  it('routes relative markdown file links to file preview paths', () => {
    expect(previewPathFromMarkdownHref('README.md')).toBe('README.md');
    expect(previewPathFromMarkdownHref('./README.md')).toBe('./README.md');
    expect(previewPathFromMarkdownHref('../README.md')).toBe('../README.md');
    expect(previewPathFromMarkdownHref('docs/plan.md')).toBe('docs/plan.md');
    expect(previewPathFromMarkdownHref(encodeURI('./光通訊/公司分析.md'))).toBe('./光通訊/公司分析.md');
    expect(previewPathFromMarkdownHref(encodeURI('../光通訊/公司分析'))).toBe('../光通訊/公司分析');
    expect(previewPathFromMarkdownHref('README.md#usage')).toBe('README.md');
    expect(previewPathFromMarkdownHref('README.md?raw=1')).toBe('README.md');
    expect(previewPathFromMarkdownHref('/repo/docs/plan.md:12')).toBe('/repo/docs/plan.md');
  });

  it('routes same-origin absolute filesystem URLs to file preview paths', () => {
    const encoded = encodeURI('/home/jimmy/Documents/Invest/光通訊/公司分析');
    expect(previewPathFromMarkdownHref(encoded)).toBe(
      '/home/jimmy/Documents/Invest/光通訊/公司分析',
    );
    expect(previewPathFromMarkdownHref(`${window.location.origin}${encoded}`)).toBe(
      '/home/jimmy/Documents/Invest/光通訊/公司分析',
    );
  });

  it('does not capture external or anchor-only links', () => {
    expect(previewPathFromMarkdownHref('https://example.com/README.md')).toBeNull();
    expect(previewPathFromMarkdownHref('example.com')).toBeNull();
    expect(previewPathFromMarkdownHref('/p/project/s/session')).toBeNull();
    expect(previewPathFromMarkdownHref(`${window.location.origin}/p/project/s/session`)).toBeNull();
    expect(previewPathFromMarkdownHref('#readme')).toBeNull();
  });
});
