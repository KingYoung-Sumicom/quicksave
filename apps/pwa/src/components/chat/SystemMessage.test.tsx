// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SystemMessage } from './SystemMessage';

describe('SystemMessage', () => {
  it('renders system errors as a visible card with clickable URLs', () => {
    const html = renderToStaticMarkup(createElement(SystemMessage, {
      card: {
        type: 'system',
        id: 'usage-limit-error',
        timestamp: 123,
        subtype: 'error',
        text: "Error: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.",
      },
    }));

    expect(html).toContain('Request failed');
    expect(html).toContain('border-red-500/40');
    expect(html).toContain('mr-auto');
    expect(html).not.toContain('mx-auto');
    expect(html).toContain('href="https://chatgpt.com/codex/settings/usage"');
    expect(html).toContain('target="_blank"');
  });

  it('renders warnings separately from errors', () => {
    const html = renderToStaticMarkup(createElement(SystemMessage, {
      card: {
        type: 'system',
        id: 'warning',
        timestamp: 123,
        subtype: 'warning',
        text: 'Account verification required.',
      },
    }));

    expect(html).toContain('Warning');
    expect(html).toContain('border-amber-500/40');
    expect(html).not.toContain('Request failed');
  });
});
