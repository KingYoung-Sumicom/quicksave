// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from './asyncQueue.js';
import { SdkProviderSession } from './claudeSdkProvider.js';
import type { StreamCardBuilder } from './cardBuilder.js';

describe('SdkProviderSession active-turn delivery', () => {
  it('rejects a steer after the previous SDK result has settled', () => {
    const builder = { userMessage: vi.fn() } as unknown as StreamCardBuilder;
    const session = new SdkProviderSession(
      { interrupt: vi.fn() } as unknown as Query,
      new AsyncQueue<SDKUserMessage>(),
      builder,
    );
    session.markTurnSettled();
    expect(session.steerUserMessage('too late')).toBe(false);
    expect(builder.userMessage).not.toHaveBeenCalled();
  });

  it('does not admit an interrupt replacement before the SDK acknowledges interrupt', async () => {
    let acknowledge!: () => void;
    const interrupt = vi.fn(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const builder = { userMessage: vi.fn(() => ({ type: 'add', card: { id: 'u1' } })) } as unknown as StreamCardBuilder;
    const input = new AsyncQueue<SDKUserMessage>();
    const session = new SdkProviderSession({ interrupt } as unknown as Query, input, builder);

    session.interruptThenSendUserMessage('urgent');
    expect(interrupt).toHaveBeenCalledOnce();
    expect(builder.userMessage).not.toHaveBeenCalled();

    acknowledge();
    await vi.waitFor(() => expect(builder.userMessage).toHaveBeenCalled());
    expect(builder.userMessage).toHaveBeenCalledWith('urgent', undefined);
    const next = await input[Symbol.asyncIterator]().next();
    expect(next.value?.message.content).toBe('urgent');
  });
});
