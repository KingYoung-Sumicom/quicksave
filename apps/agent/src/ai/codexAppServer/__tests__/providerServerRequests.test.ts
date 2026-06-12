// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import { StreamCardBuilder } from '../../cardBuilder.js';
import type { ProviderCallbacks } from '../../provider.js';

import { CodexAppServerSession } from '../provider.js';
import { CodexRpcClient, InMemoryTransport, type WireRequest, type WireResponse } from '../rpcClient.js';
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
    onSessionConfigPatch: vi.fn(),
    onModelDetected: vi.fn(),
  };
  const threadId = 'thr_1';
  const child = new EventEmitter() as AppServerHandle['child'];
  const handle: AppServerHandle = {
    rpc,
    initializeResponse: {} as AppServerHandle['initializeResponse'],
    cliVersion: '0.139.0',
    child,
    shutdown: vi.fn(),
  };
  const session = new CodexAppServerSession({
    handle,
    tokens: new TokenAccounting(),
    overrideStore: new RuntimeOverrideStore(),
    threadId,
    cardBuilder: new StreamCardBuilder(threadId, '/tmp/quicksave-test'),
    callbacks,
    onExitedFire: vi.fn(),
  });
  return { callbacks, serverSide, session, threadId };
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

  it('returns an explicit error for unsupported attestation generation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();

    const res = await sendServerRequest(h.serverSide, 'attestation/generate', {}, 'srv-attest');

    expect(res).toMatchObject({
      id: 'srv-attest',
      error: {
        code: -32000,
      },
    });
    expect((res as Extract<WireResponse, { error: unknown }>).error.message)
      .toContain('attestation/generate is not supported');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('attestation/generate'));
    warn.mockRestore();
  });

  it('logs and rejects unknown server request methods', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();

    const res = await sendServerRequest(h.serverSide, 'future/request', {
      threadId: h.threadId,
      payload: true,
    }, 'srv-future');

    expect(res).toMatchObject({
      id: 'srv-future',
      error: {
        code: -32000,
        message: 'unsupported server request method: future/request',
      },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('future/request'));
    warn.mockRestore();
  });
});

describe('CodexAppServerSession goal control requests', () => {
  it('maps goal.set to thread/goal/set and mirrors the returned goal into session config', async () => {
    const h = harness();
    const goal = makeGoal({ objective: 'Ship goal mode', tokenBudget: 123 });
    const promise = h.session.sendControlRequest('goal.set', {
      objective: '  Ship goal mode  ',
      tokenBudget: 123,
    });

    const req = await receiveClientRequest(h.serverSide);
    expect(req.method).toBe('thread/goal/set');
    expect(req.params).toEqual({
      threadId: h.threadId,
      objective: 'Ship goal mode',
      tokenBudget: 123,
    });

    await h.serverSide.send({ jsonrpc: '2.0', id: req.id, result: { goal } });
    await expect(promise).resolves.toEqual({ goal });
    expect(h.callbacks.onSessionConfigPatch).toHaveBeenCalledWith(h.threadId, expect.objectContaining({
      codexGoalPresent: true,
      codexGoalObjective: 'Ship goal mode',
      codexGoalStatus: 'active',
      codexGoalTokenBudget: 123,
    }));
  });

  it('maps goal.pause and goal.resume to thread/goal/set status updates', async () => {
    const h = harness();

    const pause = h.session.sendControlRequest('goal.pause');
    const pauseReq = await receiveClientRequest(h.serverSide);
    expect(pauseReq.method).toBe('thread/goal/set');
    expect(pauseReq.params).toEqual({ threadId: h.threadId, status: 'paused' });
    await h.serverSide.send({ jsonrpc: '2.0', id: pauseReq.id, result: { goal: makeGoal({ status: 'paused' }) } });
    await expect(pause).resolves.toMatchObject({ goal: { status: 'paused' } });

    const resume = h.session.sendControlRequest('goal.resume');
    const resumeReq = await receiveClientRequest(h.serverSide);
    expect(resumeReq.method).toBe('thread/goal/set');
    expect(resumeReq.params).toEqual({ threadId: h.threadId, status: 'active' });
    await h.serverSide.send({ jsonrpc: '2.0', id: resumeReq.id, result: { goal: makeGoal({ status: 'active' }) } });
    await expect(resume).resolves.toMatchObject({ goal: { status: 'active' } });
  });

  it('maps goal.get and goal.clear to app-server goal RPCs', async () => {
    const h = harness();

    const get = h.session.sendControlRequest('goal.get');
    const getReq = await receiveClientRequest(h.serverSide);
    expect(getReq.method).toBe('thread/goal/get');
    expect(getReq.params).toEqual({ threadId: h.threadId });
    await h.serverSide.send({ jsonrpc: '2.0', id: getReq.id, result: { goal: null } });
    await expect(get).resolves.toEqual({ goal: null });

    const clear = h.session.sendControlRequest('goal.clear');
    const clearReq = await receiveClientRequest(h.serverSide);
    expect(clearReq.method).toBe('thread/goal/clear');
    expect(clearReq.params).toEqual({ threadId: h.threadId });
    await h.serverSide.send({ jsonrpc: '2.0', id: clearReq.id, result: { cleared: true } });
    await expect(clear).resolves.toEqual({ cleared: true });
    expect(h.callbacks.onSessionConfigPatch).toHaveBeenLastCalledWith(h.threadId, expect.objectContaining({
      codexGoalPresent: false,
      codexGoalObjective: null,
    }));
  });

  it('mirrors app-server goal notifications into session config', async () => {
    const h = harness();
    const goal = makeGoal({ objective: 'Background goal update', status: 'paused' });

    await h.serverSide.send({
      jsonrpc: '2.0',
      method: 'thread/goal/updated',
      params: { threadId: h.threadId, turnId: null, goal },
    });
    await flushMicrotasks();
    expect(h.callbacks.onSessionConfigPatch).toHaveBeenCalledWith(h.threadId, expect.objectContaining({
      codexGoalObjective: 'Background goal update',
      codexGoalStatus: 'paused',
    }));

    await h.serverSide.send({
      jsonrpc: '2.0',
      method: 'thread/goal/cleared',
      params: { threadId: h.threadId },
    });
    await flushMicrotasks();
    expect(h.callbacks.onSessionConfigPatch).toHaveBeenLastCalledWith(h.threadId, expect.objectContaining({
      codexGoalPresent: false,
      codexGoalStatus: null,
    }));
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

async function receiveClientRequest(serverSide: InMemoryTransport): Promise<WireRequest> {
  return new Promise((resolve) => {
    const unsubscribe = serverSide.onMessage((message) => {
      if ('id' in message && 'method' in message) {
        unsubscribe();
        resolve(message as WireRequest);
      }
    });
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function makeGoal(overrides: Partial<{
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  tokenBudget: number | null;
}> = {}) {
  return {
    threadId: 'thr_1',
    objective: overrides.objective ?? 'Ship goal mode',
    status: overrides.status ?? 'active',
    tokenBudget: overrides.tokenBudget ?? null,
    tokensUsed: 7,
    timeUsedSeconds: 3,
    createdAt: 1000,
    updatedAt: 2000,
  };
}
