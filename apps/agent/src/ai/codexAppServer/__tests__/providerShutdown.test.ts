// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { CardEvent, CardStreamEnd } from '@sumicom/quicksave-shared';

import type { StreamCardBuilder } from '../../cardBuilder.js';
import type { ProviderCallbacks } from '../../provider.js';
import { CodexAppServerSession } from '../provider.js';
import type { AppServerHandle } from '../processManager.js';
import { RuntimeOverrideStore } from '../overrideStore.js';
import { TokenAccounting } from '../tokenAccounting.js';

function makeCallbacks(): ProviderCallbacks {
  return {
    emitCardEvent: (_event: CardEvent) => {},
    emitStreamEnd: (_result: CardStreamEnd) => {},
    handlePermissionRequest: vi.fn().mockResolvedValue({ action: 'allow' as const }),
    onModelDetected: vi.fn(),
  };
}

describe('CodexAppServerSession shutdown durability', () => {
  it('persists in-memory cards before and after shutting down the app-server child', async () => {
    const order: string[] = [];
    const child = new EventEmitter() as unknown as AppServerHandle['child'];
    const handle = {
      child,
      rpc: {
        setServerRequestHandler: vi.fn(),
      },
      shutdown: vi.fn(async () => {
        order.push('shutdown');
      }),
    } as unknown as AppServerHandle;
    const cardBuilder = {
      updateSessionId: vi.fn(),
      persistCards: vi.fn(async () => {
        order.push('persist');
      }),
    } as unknown as StreamCardBuilder;

    const session = new CodexAppServerSession({
      handle,
      tokens: new TokenAccounting(),
      overrideStore: new RuntimeOverrideStore(),
      threadId: 'thr_shutdown',
      cardBuilder,
      callbacks: makeCallbacks(),
      onExitedFire: vi.fn(),
    });

    await session.kill();

    expect(handle.shutdown).toHaveBeenCalledTimes(1);
    expect(cardBuilder.persistCards).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['persist', 'shutdown', 'persist']);
  });
});
