// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BroadcastSessionEntry } from '@sumicom/quicksave-shared';
import { ArchivedSessionsList } from './ArchivedSessionsList';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ArchivedSessionsList', () => {
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
    vi.restoreAllMocks();
  });

  it('shows the full session UUID for archived tasks', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const entry: BroadcastSessionEntry = {
      sessionId,
      cwd: '/tmp/quicksave',
      title: 'Archived task title',
      createdAt: Date.now() - 60_000,
      lastAccessedAt: Date.now(),
      archived: true,
    };
    const onListArchived = vi.fn(async () => ({
      entries: [entry],
      total: 1,
      offset: 0,
      limit: 20,
    }));

    await act(async () => {
      root.render(
        <ArchivedSessionsList
          cwd="/tmp/quicksave"
          onListArchived={onListArchived}
          onRestore={vi.fn()}
          defaultExpanded
        />,
      );
    });

    expect(container.textContent).toContain(`UUID ${sessionId}`);
  });

  it('labels provider-native sessions', async () => {
    const entry: BroadcastSessionEntry = {
      sessionId: 'native-session-id',
      cwd: '/tmp/quicksave',
      firstPrompt: 'Native task',
      createdAt: Date.now() - 60_000,
      lastAccessedAt: Date.now() - 30_000,
      lastInteractionAt: Date.now(),
      origin: 'native',
      archived: true,
    };

    await act(async () => {
      root.render(
        <ArchivedSessionsList
          cwd="/tmp/quicksave"
          onListArchived={vi.fn(async () => ({
            entries: [entry],
            total: 1,
            offset: 0,
            limit: 20,
          }))}
          onRestore={vi.fn()}
          defaultExpanded
        />,
      );
    });

    expect(container.textContent).toContain('Native');
  });
});
