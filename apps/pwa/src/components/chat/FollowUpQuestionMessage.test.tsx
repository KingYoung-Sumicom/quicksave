// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowUpQuestionMessage } from './FollowUpQuestionMessage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('FollowUpQuestionMessage', () => {
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

  it('selects a suggestion first and resolves it only after Send', async () => {
    const onRespond = vi.fn();
    await act(async () => {
      root.render(
        <FollowUpQuestionMessage
          question="Would you like me to commit it?"
          options={['Commit now', 'Keep reviewing']}
          onRespond={onRespond}
        />,
      );
    });

    expect(container.textContent).toContain('Optional follow-up');
    const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Commit now');
    await act(async () => button?.click());

    expect(onRespond).not.toHaveBeenCalled();
    expect(button?.getAttribute('aria-pressed')).toBe('true');

    const send = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Send');
    await act(async () => send?.click());

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith('Commit now');
    expect(send?.disabled).toBe(true);
  });

  it('offers a non-autofocused free-text reply when Codex gives no options', async () => {
    await act(async () => {
      root.render(<FollowUpQuestionMessage question="What should we do next?" />);
    });

    const input = container.querySelector('input');
    expect(input?.getAttribute('placeholder')).toBe('Reply if useful…');
    expect(input?.hasAttribute('autofocus')).toBe(false);
  });

  it('allows a free-text reply alongside options only when Codex permits Other', async () => {
    await act(async () => {
      root.render(
        <FollowUpQuestionMessage
          question="How detailed should this be?"
          options={['Concise', 'Detailed']}
          allowFreeText
          onRespond={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('input')?.getAttribute('placeholder')).toBe('Reply if useful…');
  });

  it('can dismiss an optional request without sending a normal chat prompt', async () => {
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(
        <FollowUpQuestionMessage
          question="How much detail would you prefer?"
          options={['Concise', 'Detailed']}
          onDismiss={onDismiss}
        />,
      );
    });

    const dismiss = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === 'Dismiss');
    await act(async () => dismiss?.click());

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(dismiss?.disabled).toBe(true);
  });

  it('renders a resolved answer as a retained conversation card', async () => {
    await act(async () => {
      root.render(
        <FollowUpQuestionMessage
          question="How much detail would you prefer?"
          options={['Concise', 'Detailed']}
          answer="Detailed"
        />,
      );
    });

    expect(container.textContent).toContain('Answered: Detailed');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
