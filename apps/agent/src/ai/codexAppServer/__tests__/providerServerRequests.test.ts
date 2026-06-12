// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import { StreamCardBuilder } from '../../cardBuilder.js';
import type { ProviderCallbacks } from '../../provider.js';

import { CodexAppServerSession } from '../provider.js';
import { CodexRpcClient, InMemoryTransport, type WireResponse } from '../rpcClient.js';
import { RuntimeOverrideStore } from '../overrideStore.js';
import { TokenAccounting } from '../tokenAccounting.js';
import { codexServerRequestInputId } from '../serverRequestIds.js';
import type { AppServerHandle } from '../processManager.js';

function harness(response: { action: 'allow' | 'deny'; response?: string } = { action: 'allow' }) {
  const [clientSide, serverSide] = InMemoryTransport.pair();
  const rpc = new CodexRpcClient(clientSide);
  const callbacks: ProviderCallbacks = {
    emitCardEvent: vi.fn(),
    emitStreamEnd: vi.fn(),
    handlePermissionRequest: vi.fn().mockResolvedValue(response),
    onModelDetected: vi.fn(),
  };
  const threadId = 'thr_1';
  const child = new EventEmitter() as AppServerHandle['child'];
  const handle: AppServerHandle = {
    rpc,
    initializeResponse: {} as AppServerHandle['initializeResponse'],
    cliVersion: '0.125.0',
    child,
    shutdown: vi.fn(),
  };
  new CodexAppServerSession({
    handle,
    tokens: new TokenAccounting(),
    overrideStore: new RuntimeOverrideStore(),
    threadId,
    cardBuilder: new StreamCardBuilder(threadId, '/tmp/quicksave-test'),
    callbacks,
    onExitedFire: vi.fn(),
  });
  return { callbacks, serverSide, threadId };
}

describe('CodexAppServerSession server-initiated requests', () => {
  it('answers item/tool/requestUserInput through the shared question prompt flow', async () => {
    const h = harness({ action: 'allow', response: 'Alice\nBlue' });

    const res = await sendServerRequest(h.serverSide, 'item/tool/requestUserInput', {
      threadId: h.threadId,
      turnId: 'turn_1',
      itemId: 'item_tool_1',
      questions: [
        { id: 'name', header: 'Profile', question: 'Name?', isOther: false, isSecret: false, options: null },
        {
          id: 'color',
          header: 'Profile',
          question: 'Color?',
          isOther: false,
          isSecret: false,
          options: [{ label: 'Blue', description: 'Primary choice' }],
        },
      ],
    }, 'srv-ask');

    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'srv-ask',
      result: {
        answers: {
          name: { answers: ['Alice'] },
          color: { answers: ['Blue'] },
        },
      },
    });
    expect(h.callbacks.handlePermissionRequest).toHaveBeenCalledWith(h.threadId, expect.objectContaining({
      requestId: codexServerRequestInputId(h.threadId, 'srv-ask'),
      inputType: 'question',
      toolName: 'AskUserQuestion',
      toolUseId: 'item_tool_1',
      skipAutoApprove: true,
    }));
  });

  it('answers mcpServer/elicitation/request form prompts with structured content', async () => {
    const h = harness({ action: 'allow', response: 'user@example.com\nYes\nAlpha' });

    const res = await sendServerRequest(h.serverSide, 'mcpServer/elicitation/request', {
      threadId: h.threadId,
      turnId: 'turn_1',
      serverName: 'demo',
      mode: 'form',
      _meta: { source: 'test' },
      message: 'Need connector details',
      requestedSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', title: 'Email' },
          consent: { type: 'boolean', title: 'Consent' },
          choice: {
            type: 'string',
            title: 'Choice',
            oneOf: [{ const: 'a', title: 'Alpha' }],
          },
        },
        required: ['email'],
      },
    }, 'srv-mcp');

    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 'srv-mcp',
      result: {
        action: 'accept',
        content: {
          email: 'user@example.com',
          consent: true,
          choice: 'a',
        },
        _meta: { source: 'test' },
      },
    });
  });

  it('returns a visible failure result for unsupported dynamic tool calls', async () => {
    const h = harness();

    const res = await sendServerRequest(h.serverSide, 'item/tool/call', {
      threadId: h.threadId,
      turnId: 'turn_1',
      callId: 'call_1',
      namespace: 'demo',
      tool: 'lookup',
      arguments: { q: 'x' },
    }, 'srv-dyn');

    expect(res).toMatchObject({
      id: 'srv-dyn',
      result: {
        success: false,
        contentItems: [{ type: 'inputText' }],
      },
    });
    expect(JSON.stringify((res as Extract<WireResponse, { result: unknown }>).result)).toContain('demo:lookup');
    expect(h.callbacks.handlePermissionRequest).not.toHaveBeenCalled();
  });

  it('returns an explicit error for unsupported external ChatGPT token refresh', async () => {
    const h = harness();

    const res = await sendServerRequest(h.serverSide, 'account/chatgptAuthTokens/refresh', {
      reason: 'unauthorized',
      previousAccountId: 'org_1',
    }, 'srv-auth');

    expect(res).toMatchObject({
      id: 'srv-auth',
      error: {
        code: -32000,
      },
    });
    expect((res as Extract<WireResponse, { error: unknown }>).error.message)
      .toContain('chatgptAuthTokens refresh is not supported');
  });
});

async function sendServerRequest(
  serverSide: InMemoryTransport,
  method: string,
  params: unknown,
  id: string,
): Promise<WireResponse> {
  let response: WireResponse | null = null;
  const unsubscribe = serverSide.onMessage((message) => {
    if ('id' in message && ('result' in message || 'error' in message)) {
      response = message as WireResponse;
    }
  });
  try {
    await serverSide.send({ jsonrpc: '2.0', id, method, params });
    for (let i = 0; i < 10 && !response; i++) await Promise.resolve();
    if (!response) throw new Error(`no response for ${method}`);
    return response;
  } finally {
    unsubscribe();
  }
}
