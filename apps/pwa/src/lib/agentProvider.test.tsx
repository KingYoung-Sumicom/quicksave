// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentProvider, type AgentDynamicData } from './agentProvider';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('OpenCode agent provider', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('lets an active session select a different discovered model', async () => {
    const provider = getAgentProvider('opencode');
    const onChange = vi.fn();
    const dynamic: AgentDynamicData = {
      opencodeModels: [
        {
          id: 'anthropic/claude-sonnet',
          name: 'Claude Sonnet',
          providerId: 'anthropic',
          providerName: 'Anthropic',
        },
        {
          id: 'openai/gpt-5',
          name: 'GPT-5',
          providerId: 'openai',
          providerName: 'OpenAI',
        },
      ],
    };

    function Harness() {
      const [openPopover, setOpenPopover] = useState<string | null>(null);
      return (
        <>
          {provider.renderStatusChips(
            {
              model: 'anthropic/claude-sonnet',
              permissionMode: 'bypassPermissions',
            },
            onChange,
            {
              dynamic,
              openPopover,
              onOpenPopover: setOpenPopover,
            },
          )}
        </>
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });

    const selectedModel = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Claude Sonnet'));
    expect(selectedModel).toBeTruthy();

    await act(async () => {
      selectedModel!.click();
    });

    const nextModel = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'GPT-5');
    expect(nextModel).toBeTruthy();

    await act(async () => {
      nextModel!.click();
    });

    expect(onChange).toHaveBeenCalledWith('model', 'openai/gpt-5');
  });
});
