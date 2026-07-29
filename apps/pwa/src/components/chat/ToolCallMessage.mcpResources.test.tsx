// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolCallMessage } from './ToolCallMessage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ToolCallMessage MCP resource tools', () => {
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

  it('renders list_mcp_resources with its server and result', async () => {
    await act(async () => {
      root.render(
        <ToolCallMessage
          toolName="list_mcp_resources"
          toolInput='{"server":"filesystem"}'
          content=""
          toolResultContent={'resource://one\nresource://two'}
        />,
      );
    });

    expect(container.textContent).toContain('List MCP resources');
    expect(container.textContent).toContain('filesystem');
    expect(container.textContent).toContain('resource://one');
    expect(container.textContent).toContain('resource://two');
  });

  it('renders read_mcp_resource with its server and URI', async () => {
    await act(async () => {
      root.render(
        <ToolCallMessage
          toolName="read_mcp_resource"
          toolInput='{"server":"docs","uri":"docs://reference/tools"}'
          content=""
          toolResultContent="resource contents"
        />,
      );
    });

    expect(container.textContent).toContain('Read MCP resource');
    expect(container.textContent).toContain('docs');
    expect(container.textContent).toContain('docs://reference/tools');
    expect(container.textContent).toContain('resource contents');
  });
});
