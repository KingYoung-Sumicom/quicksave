// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractiveQuestionView } from './InteractiveQuestionView';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('InteractiveQuestionView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders an OpenCode blocking question without an optional-follow-up affordance or custom response when disabled', async () => {
    const onRespond = vi.fn();
    await act(async () => {
      root.render(
        <InteractiveQuestionView
          request={{
            sessionId: 'ses_1', requestId: 'question_1', inputType: 'question',
            title: 'Choose one', toolName: 'AskUserQuestion', toolInput: {},
          }}
          parsedInput={{
            questions: [{
              header: 'Language', question: 'Which language?', allowFreeText: false,
              options: [{ label: 'TypeScript', description: 'Typed JavaScript' }],
            }],
          }}
          onRespond={onRespond}
        />,
      );
    });

    expect(container.textContent).toContain('Which language?');
    expect(container.textContent).not.toContain('Optional follow-up');
    expect(container.textContent).not.toContain('Other');

    const option = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.includes('TypeScript'));
    await act(async () => option?.click());
    const confirm = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Confirm');
    await act(async () => confirm?.click());

    expect(onRespond).toHaveBeenCalledWith('allow', 'TypeScript');
  });
});
