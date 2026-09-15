// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentProvider, type AgentDynamicData } from './agentProvider';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPENCODE_DYNAMIC: AgentDynamicData = {
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
    {
      id: 'openai/gpt-5-mini',
      name: 'GPT-5 Mini',
      providerId: 'openai',
      providerName: 'OpenAI',
    },
  ],
};

function chipsHarness(
  providerId: Parameters<typeof getAgentProvider>[0],
  initialValues: Record<string, unknown>,
  onChange: (key: string, value: unknown) => void,
  dynamic: AgentDynamicData,
) {
  const provider = getAgentProvider(providerId);

  function Harness() {
    const [openPopover, setOpenPopover] = useState<string | null>(null);
    const [values, setValues] = useState(initialValues);
    const handle = (key: string, value: unknown) => {
      onChange(key, value);
      setValues((prev) => ({ ...prev, [key]: value }));
    };
    return (
      <>
        {provider.renderStatusChips(values, handle, {
          dynamic,
          openPopover,
          onOpenPopover: setOpenPopover,
        })}
      </>
    );
  }

  return Harness;
}

function chipByText(container: HTMLDivElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent?.includes(text)) as HTMLButtonElement | undefined;
}

describe('OpenCode agent provider status chips', () => {
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

  it('splits the grouped catalog into provider and model chips', async () => {
    const onChange = vi.fn();
    const Harness = chipsHarness('opencode', { model: 'anthropic/claude-sonnet', permissionMode: 'bypassPermissions' }, onChange, OPENCODE_DYNAMIC);

    await act(async () => {
      root.render(<Harness />);
    });

    // Provider chip first, model chip second — no flat all-models dropdown.
    expect(chipByText(container, 'Anthropic')).toBeTruthy();
    expect(chipByText(container, 'Claude Sonnet')).toBeTruthy();
    expect(chipByText(container, 'GPT-5')).toBeUndefined();
  });

  it('keeps the model dropdown scoped to the selected provider', async () => {
    const onChange = vi.fn();
    const Harness = chipsHarness('opencode', { model: 'openai/gpt-5', permissionMode: 'bypassPermissions' }, onChange, OPENCODE_DYNAMIC);

    await act(async () => {
      root.render(<Harness />);
    });

    // Open the MODEL chip — its dropdown is scoped to the current provider.
    await act(async () => {
      chipByText(container, 'GPT-5')!.click();
    });

    expect(chipByText(container, 'GPT-5 Mini')).toBeTruthy();
    expect(container.textContent).not.toContain('Claude Sonnet');

    await act(async () => {
      chipByText(container, 'GPT-5 Mini')!.click();
    });

    expect(onChange).toHaveBeenCalledWith('model', 'openai/gpt-5-mini');
  });

  it('switching provider selects that provider’s first model', async () => {
    const onChange = vi.fn();
    const Harness = chipsHarness('opencode', { model: 'anthropic/claude-sonnet', permissionMode: 'bypassPermissions' }, onChange, OPENCODE_DYNAMIC);

    await act(async () => {
      root.render(<Harness />);
    });

    // Open the PROVIDER chip and pick a different provider.
    await act(async () => {
      chipByText(container, 'Anthropic')!.click();
    });

    await act(async () => {
      chipByText(container, 'OpenAI')!.click();
    });

    expect(onChange).toHaveBeenCalledWith('model', 'openai/gpt-5');
    expect(chipByText(container, 'GPT-5')).toBeTruthy();
  });

  it('falls back to the first provider when the selected model is unknown', async () => {
    const onChange = vi.fn();
    const Harness = chipsHarness('opencode', { model: 'gone/model', permissionMode: 'bypassPermissions' }, onChange, OPENCODE_DYNAMIC);

    await act(async () => {
      root.render(<Harness />);
    });

    expect(chipByText(container, 'Anthropic')).toBeTruthy();
    expect(chipByText(container, 'gone/model')).toBeTruthy();
  });

  it('renders a single model chip when only one provider exists', async () => {
    const onChange = vi.fn();
    const dynamic: AgentDynamicData = {
      opencodeModels: [
        { id: 'thor/qwen3.8', name: 'Qwen 3.8', providerId: 'thor', providerName: 'Thor' },
        { id: 'thor/qwen3.6', name: 'Qwen 3.6', providerId: 'thor', providerName: 'Thor' },
      ],
    };
    const Harness = chipsHarness('opencode', { model: 'thor/qwen3.8', permissionMode: 'bypassPermissions' }, onChange, dynamic);

    await act(async () => {
      root.render(<Harness />);
    });

    expect(chipByText(container, 'Qwen 3.8')).toBeTruthy();
    expect(chipByText(container, 'Thor')).toBeUndefined();

    await act(async () => {
      chipByText(container, 'Qwen 3.8')!.click();
    });

    // Both models of the single provider, still just one chip.
    expect(chipByText(container, 'Qwen 3.6')).toBeTruthy();
    expect(chipByText(container, 'Thor')).toBeUndefined();
  });
});

describe('Claude Code agent provider status chips', () => {
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

  it('still renders one model chip for an ungrouped catalog', async () => {
    const onChange = vi.fn();
    const Harness = chipsHarness('claude-code', { model: 'claude-sonnet-4-6', permissionMode: 'auto', contextWindow: 200000 }, onChange, {});

    await act(async () => {
      root.render(<Harness />);
    });

    // One model chip — no provider chip for ungrouped catalogs.
    const modelChips = Array.from(container.querySelectorAll('button'))
      .filter((b) => b.textContent?.includes('Sonnet 4.6'));
    expect(modelChips.length).toBe(1);
  });
});
