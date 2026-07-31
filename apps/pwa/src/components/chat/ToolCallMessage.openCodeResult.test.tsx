// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolCallMessage } from './ToolCallMessage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ToolCallMessage OpenCode results', () => {
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

  it('shows the parsed path and content without OpenCode wrapper tags', async () => {
    const result = [
      '<path>/repo/src/openCodeServer.ts</path>',
      '<type>file</type>',
      '<content>',
      '1: export class OpenCodeServer {}',
      '',
      '(End of file - total 1 lines)',
      '</content>',
      '',
      '<system-reminder>',
      'Model-only instructions',
      '</system-reminder>',
    ].join('\n');

    await act(async () => {
      root.render(
        <ToolCallMessage
          toolName="Read"
          toolInput="{}"
          content=""
          toolResultContent={result}
        />,
      );
    });

    expect(container.textContent).toContain('openCodeServer.ts');
    expect(container.textContent).not.toContain('<path>');
    expect(container.textContent).not.toContain('Model-only instructions');

    const expandButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('3 lines'));
    expect(expandButton).toBeDefined();

    await act(async () => {
      expandButton?.click();
    });

    expect(container.textContent).toContain('export class OpenCodeServer {}');
    expect(container.textContent).not.toContain('<content>');
    expect(container.textContent).not.toContain('<system-reminder>');
  });

  it('shows shell termination metadata without OpenCode wrapper tags', async () => {
    const result = [
      'partial output',
      '',
      '<shell_metadata>',
      'User aborted the command',
      '</shell_metadata>',
    ].join('\n');

    await act(async () => {
      root.render(
        <ToolCallMessage
          toolName="Bash"
          toolInput='{"command":"sleep 10"}'
          content=""
          toolResultContent={result}
        />,
      );
    });

    const expandButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('3 lines'));
    expect(expandButton).toBeDefined();

    await act(async () => {
      expandButton?.click();
    });

    expect(container.textContent).toContain('partial output');
    expect(container.textContent).toContain('User aborted the command');
    expect(container.textContent).not.toContain('<shell_metadata>');
  });
});
