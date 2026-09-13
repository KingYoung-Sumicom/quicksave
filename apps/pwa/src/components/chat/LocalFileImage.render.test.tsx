// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFilePreviewStore } from '../../stores/filePreviewStore';
import { LocalFileImage } from './LocalFileImage';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

vi.mock('../../hooks/useFileOps', () => ({
  useFileOps: () => ({ readFile: mocks.readFile }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('LocalFileImage rendering', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.readFile.mockReset();
    useFilePreviewStore.setState({ current: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('reads a relative image through the cached file pipeline and renders its bytes', async () => {
    mocks.readFile.mockResolvedValue({
      success: true,
      kind: 'image',
      encoding: 'base64',
      mimeType: 'image/png',
      content: 'cG5n',
    });

    await act(async () => {
      root.render(
        <LocalFileImage
          src="../images/chart.png"
          alt="chart"
          cwd="/project"
          baseDir="/project/docs"
          agentId="agent-a"
        />,
      );
    });

    expect(mocks.readFile).toHaveBeenCalledWith({
      cwd: '/project',
      path: '/project/images/chart.png',
      allowImage: true,
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,cG5n');

    act(() => container.querySelector('button')?.click());
    expect(useFilePreviewStore.getState().current).toEqual({
      cwd: '/project',
      path: '/project/images/chart.png',
      agentId: 'agent-a',
    });
  });
});
