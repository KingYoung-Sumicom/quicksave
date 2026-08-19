// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatMarkdown, previewPathFromMarkdownHref } from './ChatMarkdown';

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

  it('routes arbitrary absolute Unix paths to file preview paths', () => {
    const path = '/private/tmp/orin-eco2-replay.xAbghh/render-root/I30V11-CVM connector 3 of 3.png';

    expect(previewPathFromMarkdownHref(encodeURI(path))).toBe(path);
    expect(previewPathFromMarkdownHref('/custom/mount/with spaces/report.pdf')).toBe(
      '/custom/mount/with spaces/report.pdf',
    );
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      children: `[I30V11-CVM connector 3 of 3.png](${encodeURI(path)})`,
    }));
    expect(html).toContain('<button');
    expect(html).toContain('I30V11-CVM connector 3 of 3.png');
    expect(html).toContain(`title="${path}"`);
  });

  it('does not capture external or anchor-only links', () => {
    expect(previewPathFromMarkdownHref('https://example.com/README.md')).toBeNull();
    expect(previewPathFromMarkdownHref('example.com')).toBeNull();
    expect(previewPathFromMarkdownHref('#readme')).toBeNull();
  });

  it('treats app-shaped absolute paths as files too', () => {
    expect(previewPathFromMarkdownHref('/p/project/s/session')).toBe('/p/project/s/session');
    expect(previewPathFromMarkdownHref(`${window.location.origin}/p/project/s/session`)).toBe(
      '/p/project/s/session',
    );
  });
});

describe('ChatMarkdown math rendering', () => {
  it('renders Codex display-math delimiters with KaTeX', () => {
    const markdown = String.raw`\[
L_{\text{until-change}} = -\operatorname{mean}_{t\in\text{有效換倉}}(A_t)
\]`;
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { children: markdown }));

    expect(html).toContain('class="katex-display"');
    expect(html).toContain('until-change');
    expect(html).not.toContain('\\[');
  });

  it('renders Codex inline-math delimiters and leaves single dollars literal', () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      children: String.raw`Codex \(A_t\) and Markdown $B_t$.`,
    }));

    expect(html.match(/class="katex"/g)).toHaveLength(1);
    expect(html).toContain('$B_t$');
  });

  it('renders separate currency amounts as prose instead of one wide equation', () => {
    const markdown = 'Pixhawk 6X module 是 $166.99，但加 Mini carrier 後變成 $286.98；Standard 套裝則是 $320.98。';
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { children: markdown }));

    expect(html).toContain('$166.99');
    expect(html).toContain('$286.98');
    expect(html).toContain('$320.98');
    expect(html).not.toContain('class="katex"');
  });

  it('renders only the bounded display equation in a mixed prose payload', () => {
    const markdown = [
      '1. **方向有事後標準答案**',
      '   固定持有期間、交易成本與 BTC-relative 基準後，可以定義：',
      String.raw`   \[`,
      String.raw`   y_t=\operatorname{sign}(U_t(\text{long})-U_t(\text{short}))`,
      String.raw`   \]`,
      '   但它不一定等於單純的下一根 8h 漲跌；`prev position` 也可能改變答案。',
      '',
      '2. `P(direction correct | state)` 可以用 BCE 等 proper loss 學習。',
    ].join('\n');
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { children: markdown }));

    expect(html.match(/class="katex-display"/g)).toHaveLength(1);
    expect(html).toContain('但它不一定等於單純的下一根 8h 漲跌');
    expect(html).toContain('<code>prev position</code>');
    expect(html).toContain('<code>P(direction correct | state)</code>');
  });
});

describe('ChatMarkdown file links', () => {
  it('does not infer file links from inline code', () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { children: '`apps/pwa/src/App.tsx`' }));

    expect(html).toContain('<code>apps/pwa/src/App.tsx</code>');
    expect(html).not.toContain('<a');
  });

  it('keeps explicitly authored Markdown file links interactive', () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      children: '[open file](apps/pwa/src/App.tsx)',
    }));

    expect(html).toContain('open file');
    expect(html).toContain('<button');
  });

  it('renders Codex file citation headers as explicit file links', () => {
    const path = '/Users/jimmy/Documents/P3768_A04_OrCAD_schematics(base_version).pdf';
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      children: `:codex-file-citation{path="${path}" purpose="source"}`,
    }));

    expect(html).toContain('<button');
    expect(html).toContain('Source · P3768_A04_OrCAD_schematics(base_version).pdf');
    expect(html).toContain(`title="${path}"`);
    expect(html).not.toContain(':codex-file-citation');
  });
});
