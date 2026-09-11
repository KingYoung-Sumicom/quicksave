// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import { StreamCardBuilder } from '../../cardBuilder.js';
import type { ProviderCallbacks } from '../../provider.js';

import {
  CodexAppServerSession,
  isNativeCompletionFeatureEnabled,
  nativeCompletionEnvelope,
  supportsNativeCompletionProtocol,
} from '../provider.js';
import type { ReadyNativeExecCompletion } from '../nativeExecCompletionTracker.js';
import { CodexRpcClient, InMemoryTransport, type WireRequest, type WireResponse } from '../rpcClient.js';
import { RuntimeOverrideStore } from '../overrideStore.js';
import { TokenAccounting, makeBreakdown, makeUsage } from '../tokenAccounting.js';
import { codexServerRequestInputId } from '../serverRequestIds.js';
import type { AppServerHandle } from '../processManager.js';

function harness(response: { action: 'allow' | 'deny'; response?: string } = { action: 'allow' }) {
  const [clientSide, serverSide] = InMemoryTransport.pair();
  const rpc = new CodexRpcClient(clientSide);
  const callbacks: ProviderCallbacks = {
    emitCardEvent: vi.fn(),
    emitStreamEnd: vi.fn(),
    handlePermissionRequest: vi.fn().mockResolvedValue(response),
    onQueueStateChange: vi.fn(),
    onSessionConfigPatch: vi.fn(),
    onModelDetected: vi.fn(),
  };
  const threadId = 'thr_1';
  const child = new EventEmitter() as AppServerHandle['child'];
  const handle: AppServerHandle = {
    rpc,
    initializeResponse: {} as AppServerHandle['initializeResponse'],
    cliVersion: '0.153.4',
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

describe('CodexAppServerSession slash command listing', () => {
  it('includes Codex goal mode as a built-in command before skills', async () => {
    const h = harness();
    const promise = h.session.listSlashCommands({ cwd: '/repo' });
    const req = await receiveClientRequest(h.serverSide);
    expect(req.method).toBe('skills/list');
    expect(req.params).toEqual({ cwds: ['/repo'], forceReload: false });

    await h.serverSide.send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        data: [
          {
            cwd: '/repo',
            errors: [],
            skills: [
              {
                name: 'goal',
                description: 'skill duplicate',
                path: '/skills/goal/SKILL.md',
                scope: 'project',
                enabled: true,
              },
              {
                name: 'imagegen',
                description: 'Create visual assets',
                path: '/skills/imagegen/SKILL.md',
                scope: 'system',
                enabled: true,
              },
            ],
          },
        ],
      },
    });

    await expect(promise).resolves.toEqual([
      {
        name: 'goal',
        description: 'Manage Codex goal mode',
        argumentHint: 'pause | resume | clear | set <objective>',
      },
      {
        name: 'imagegen',
        description: 'Create visual assets',
        source: 'codex-skill',
      },
    ]);
  });
});

describe('CodexAppServerSession active-turn follow-up routing', () => {
  it('steers a normal follow-up into the current active turn', async () => {
    const h = harness();
    const startReqPromise = receiveClientRequest(h.serverSide);
    const run = h.session.runTurn('initial prompt');

    const startReq = await startReqPromise;
    expect(startReq.method).toBe('turn/start');
    await h.serverSide.send({ jsonrpc: '2.0', id: startReq.id, result: { turn: makeTurn('turn_1', 'inProgress') } });
    await flushMicrotasks();

    const steerReqPromise = receiveClientRequest(h.serverSide);
    h.session.sendUserMessage('adjust course');

    const steerReq = await steerReqPromise;
    expect(steerReq.method).toBe('turn/steer');
    expect(steerReq.params).toEqual({
      threadId: h.threadId,
      input: [{ type: 'text', text: 'adjust course', text_elements: [] }],
      expectedTurnId: 'turn_1',
    });
    await h.serverSide.send({ jsonrpc: '2.0', id: steerReq.id, result: { turnId: 'turn_1' } });

    await h.serverSide.send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: h.threadId, turn: makeTurn('turn_1', 'completed') },
    });
    await run;

    expect(h.callbacks.emitStreamEnd).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: h.threadId,
      turnId: 'turn_1',
      success: true,
    }));
    expect(h.callbacks.onQueueStateChange).not.toHaveBeenCalled();
  });

  it('queues the follow-up for the next turn when active-turn steering fails', async () => {
    const h = harness();
    const firstStartReqPromise = receiveClientRequest(h.serverSide);
    const run = h.session.runTurn('initial prompt');

    const firstStartReq = await firstStartReqPromise;
    expect(firstStartReq.method).toBe('turn/start');
    await h.serverSide.send({ jsonrpc: '2.0', id: firstStartReq.id, result: { turn: makeTurn('turn_1', 'inProgress') } });
    await flushMicrotasks();

    const steerReqPromise = receiveClientRequest(h.serverSide);
    h.session.sendUserMessage('next turn fallback');

    const steerReq = await steerReqPromise;
    expect(steerReq.method).toBe('turn/steer');
    await h.serverSide.send({
      jsonrpc: '2.0',
      id: steerReq.id,
      error: { code: -32602, message: 'no active steerable turn' },
    });

    await flushMicrotasks();
    expect(h.callbacks.onQueueStateChange).toHaveBeenCalled();
    expect(h.session.getQueueState()).toMatchObject({
      pendingUserMessages: 1,
      latestPromptPreview: 'next turn fallback',
    });

    const secondStartReqPromise = receiveClientRequest(h.serverSide);
    await h.serverSide.send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: h.threadId, turn: makeTurn('turn_1', 'completed') },
    });

    const secondStartReq = await secondStartReqPromise;
    expect(secondStartReq.method).toBe('turn/start');
    expect(secondStartReq.params).toMatchObject({
      threadId: h.threadId,
      input: [{ type: 'text', text: 'next turn fallback', text_elements: [] }],
    });
    await h.serverSide.send({ jsonrpc: '2.0', id: secondStartReq.id, result: { turn: makeTurn('turn_2', 'inProgress') } });
    await flushMicrotasks();
    await sendTokenUsage(h, 'turn_2');
    await h.serverSide.send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: h.threadId, turn: makeTurn('turn_2', 'completed') },
    });
    await run;

    expect(h.callbacks.emitStreamEnd).toHaveBeenCalledTimes(2);
    expect(h.session.getQueueState()).toBeNull();
  });

  it('auto-steers the first queued follow-up when the active turn starts a tool call', async () => {
    const h = harness();
    const startReqPromise = receiveClientRequest(h.serverSide);
    const run = h.session.runTurn('initial prompt');

    const startReq = await startReqPromise;
    expect(startReq.method).toBe('turn/start');
    await h.serverSide.send({ jsonrpc: '2.0', id: startReq.id, result: { turn: makeTurn('turn_1', 'inProgress') } });
    await flushMicrotasks();

    const failedSteerReqPromise = receiveClientRequest(h.serverSide);
    h.session.sendUserMessage('queued until a tool call');

    const failedSteerReq = await failedSteerReqPromise;
    expect(failedSteerReq.method).toBe('turn/steer');
    await h.serverSide.send({
      jsonrpc: '2.0',
      id: failedSteerReq.id,
      error: { code: -32602, message: 'no active steerable turn' },
    });

    await flushMicrotasks();
    expect(h.session.getQueueState()).toMatchObject({
      pendingUserMessages: 1,
      latestPromptPreview: 'queued until a tool call',
    });

    const autoSteerReqPromise = receiveClientRequest(h.serverSide);
    await h.serverSide.send({
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        threadId: h.threadId,
        turnId: 'turn_1',
        item: {
          type: 'mcpToolCall',
          id: 'tool_1',
          server: 'quicksave',
          tool: 'Bash',
          status: 'inProgress',
          arguments: { command: 'pwd' },
          pluginId: null,
          result: null,
          error: null,
          durationMs: null,
        },
      },
    });

    const autoSteerReq = await autoSteerReqPromise;
    expect(autoSteerReq.method).toBe('turn/steer');
    expect(autoSteerReq.params).toEqual({
      threadId: h.threadId,
      input: [{ type: 'text', text: 'queued until a tool call', text_elements: [] }],
      expectedTurnId: 'turn_1',
    });
    await h.serverSide.send({ jsonrpc: '2.0', id: autoSteerReq.id, result: { turnId: 'turn_1' } });
    await flushMicrotasks();
    expect(h.session.getQueueState()).toBeNull();

    await h.serverSide.send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: h.threadId, turn: makeTurn('turn_1', 'completed') },
    });
    await run;

    expect(h.callbacks.emitStreamEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps a queued follow-up for the next turn after manual interrupt', async () => {
    const h = harness();
    const startReqPromise = receiveClientRequest(h.serverSide);
    const run = h.session.runTurn('initial prompt');

    const startReq = await startReqPromise;
    expect(startReq.method).toBe('turn/start');
    await h.serverSide.send({ jsonrpc: '2.0', id: startReq.id, result: { turn: makeTurn('turn_1', 'inProgress') } });
    await flushMicrotasks();

    const failedSteerReqPromise = receiveClientRequest(h.serverSide);
    h.session.sendUserMessage('run after interrupt');

    const failedSteerReq = await failedSteerReqPromise;
    expect(failedSteerReq.method).toBe('turn/steer');
    await h.serverSide.send({
      jsonrpc: '2.0',
      id: failedSteerReq.id,
      error: { code: -32602, message: 'no active steerable turn' },
    });
    await flushMicrotasks();
    expect(h.session.getQueueState()).toMatchObject({
      pendingUserMessages: 1,
      latestPromptPreview: 'run after interrupt',
    });

    const recorder = recordClientRequests(h.serverSide);
    try {
      const steerResult = h.session.steerQueuedMessage({ interruptCurrentTurn: true });
      await h.serverSide.send({
        jsonrpc: '2.0',
        method: 'item/started',
        params: {
          threadId: h.threadId,
          turnId: 'turn_1',
          item: {
            type: 'mcpToolCall',
            id: 'tool_1',
            server: 'quicksave',
            tool: 'Bash',
            status: 'inProgress',
            arguments: { command: 'pwd' },
            pluginId: null,
            result: null,
            error: null,
            durationMs: null,
          },
        },
      });
      await expect(steerResult).resolves.toBe(true);

      const interruptReq = await recorder.waitFor((req) => req.method === 'turn/interrupt');
      expect(interruptReq.params).toEqual({ threadId: h.threadId, turnId: 'turn_1' });
      await h.serverSide.send({ jsonrpc: '2.0', id: interruptReq.id, result: {} });
      await flushMicrotasks();

      expect(recorder.requests.some((req) => req.method === 'turn/steer')).toBe(false);

      const secondStartReq = await recorder.waitFor((req) => req.method === 'turn/start');
      expect(secondStartReq.params).toMatchObject({
        threadId: h.threadId,
        input: [{ type: 'text', text: 'run after interrupt', text_elements: [] }],
      });
      await h.serverSide.send({ jsonrpc: '2.0', id: secondStartReq.id, result: { turn: makeTurn('turn_2', 'inProgress') } });
      await flushMicrotasks();
      await sendTokenUsage(h, 'turn_2');
      await h.serverSide.send({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: h.threadId, turn: makeTurn('turn_2', 'completed') },
      });
      await run;
    } finally {
      recorder.unsubscribe();
    }

    expect(h.callbacks.emitStreamEnd).toHaveBeenCalledTimes(2);
    expect(h.session.getQueueState()).toBeNull();
  });

  it('unblocks a later prompt when interrupt has no turn/completed notification', async () => {
    const h = harness();
    const firstStartReqPromise = receiveClientRequest(h.serverSide);
    const run = h.session.runTurn('initial prompt');

    const firstStartReq = await firstStartReqPromise;
    expect(firstStartReq.method).toBe('turn/start');
    await h.serverSide.send({ jsonrpc: '2.0', id: firstStartReq.id, result: { turn: makeTurn('turn_1', 'inProgress') } });
    await flushMicrotasks();

    const interruptReqPromise = receiveClientRequest(h.serverSide);
    h.session.interrupt();
    const interruptReq = await interruptReqPromise;
    expect(interruptReq.method).toBe('turn/interrupt');
    expect(interruptReq.params).toEqual({ threadId: h.threadId, turnId: 'turn_1' });
    await h.serverSide.send({ jsonrpc: '2.0', id: interruptReq.id, result: {} });

    await resolvesWithin(run);
    expect(h.callbacks.emitStreamEnd).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: h.threadId,
      turnId: 'turn_1',
      success: false,
      interrupted: true,
    }));

    const secondStartReqPromise = receiveClientRequest(h.serverSide);
    h.session.sendUserMessage('after stop');
    const secondStartReq = await secondStartReqPromise;
    expect(secondStartReq.method).toBe('turn/start');
    expect(secondStartReq.params).toMatchObject({
      threadId: h.threadId,
      input: [{ type: 'text', text: 'after stop', text_elements: [] }],
    });
    await h.serverSide.send({ jsonrpc: '2.0', id: secondStartReq.id, result: { turn: makeTurn('turn_2', 'inProgress') } });
    await flushMicrotasks();
    await sendTokenUsage(h, 'turn_2');
    await h.serverSide.send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: h.threadId, turn: makeTurn('turn_2', 'completed') },
    });
    await flushMicrotasks();

    expect(h.callbacks.emitStreamEnd).toHaveBeenCalledTimes(2);
    expect(h.callbacks.emitStreamEnd).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: h.threadId,
      turnId: 'turn_2',
      success: true,
    }));
  });
});

describe('CodexAppServerSession session-scoped notification routing', () => {
  it('keeps observing Codex turns after a regular turn completed', async () => {
    const h = harness();
    const firstStartReqPromise = receiveClientRequest(h.serverSide);
    const run = h.session.runTurn('initial prompt');

    const firstStartReq = await firstStartReqPromise;
    await h.serverSide.send({ jsonrpc: '2.0', id: firstStartReq.id, result: { turn: makeTurn('turn_1', 'inProgress') } });
    await flushMicrotasks();
    await sendTokenUsage(h, 'turn_1');
    await h.serverSide.send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: h.threadId, turn: makeTurn('turn_1', 'completed') },
    });
    await run;

    expect(h.callbacks.emitStreamEnd).toHaveBeenCalledTimes(1);
    vi.mocked(h.callbacks.onQueueStateChange).mockClear();

    await sendTokenUsage(h, 'turn_1');
    await flushMicrotasks();
    expect(h.callbacks.emitStreamEnd).toHaveBeenCalledTimes(1);
    expect(h.callbacks.onQueueStateChange).not.toHaveBeenCalled();

    await h.serverSide.send({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { threadId: h.threadId, turn: makeTurn('turn_2', 'inProgress') },
    });
    await flushMicrotasks();
    expect(h.callbacks.onQueueStateChange).toHaveBeenCalledWith(h.threadId);

    await h.serverSide.send({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        threadId: h.threadId,
        turnId: 'turn_2',
        item: { type: 'agentMessage', id: 'msg_2', text: 'background update', phase: null, memoryCitation: null },
      },
    });
    await sendTokenUsage(h, 'turn_2');
    await h.serverSide.send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId: h.threadId, turn: makeTurn('turn_2', 'completed') },
    });
    await flushMicrotasks();

    expect(h.callbacks.emitStreamEnd).toHaveBeenCalledTimes(2);
    expect(h.callbacks.emitStreamEnd).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: h.threadId,
      turnId: 'turn_2',
      success: true,
    }));
    const cardEvents = vi.mocked(h.callbacks.emitCardEvent).mock.calls.map(([event]) => event);
    expect(cardEvents.some((event) =>
      event.type === 'add'
      && event.card.type === 'assistant_text'
      && event.card.text === 'background update',
    )).toBe(true);
  });
});

describe('CodexAppServerSession registered native completion continuation', () => {
  it('continues only a native command explicitly registered by the agent', async () => {
    const h = harness();
    const run = h.session.runTurn('monitor the process');
    const initial = await receiveClientRequest(h.serverSide);
    await h.serverSide.send({ jsonrpc: '2.0', id: initial.id, result: { turn: makeTurn('turn_1', 'inProgress') } });
    await flushMicrotasks();

    await h.serverSide.send({
      jsonrpc: '2.0', method: 'item/started',
      params: { threadId: h.threadId, turnId: 'turn_1', item: runningNativeCommand('cmd_1') },
    });
    await h.serverSide.send({
      jsonrpc: '2.0', method: 'item/started',
      params: { threadId: h.threadId, turnId: 'turn_1', item: nativeCompletionRegistration('reg_1', '777') },
    });
    // The process can finish before final-answer streaming; an explicit
    // registration keeps it eligible until the normal scheduler is idle.
    await h.serverSide.send({
      jsonrpc: '2.0', method: 'item/completed',
      params: { threadId: h.threadId, turnId: 'turn_1', item: completedNativeCommand('cmd_1') },
    });

    const runtimeStartPromise = receiveClientRequest(h.serverSide);
    await sendTokenUsage(h, 'turn_1');
    await h.serverSide.send({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { threadId: h.threadId, turn: makeTurn('turn_1', 'completed') },
    });
    await run;

    const runtime = await runtimeStartPromise;
    expect(runtime.method).toBe('turn/start');
    expect(runtime.params).toMatchObject({
      threadId: h.threadId,
      input: [],
      toolOutput: { namespace: 'quicksave', name: 'background_execution_completed' },
    });
    expect(JSON.parse((runtime.params as { toolOutput: { output: string } }).toolOutput.output)).toMatchObject({
      events: [expect.objectContaining({
        commandExecutionId: 'cmd_1',
        processHandle: '777',
        status: 'completed',
      })],
    });

    await h.serverSide.send({ jsonrpc: '2.0', id: runtime.id, result: { turn: makeTurn('turn_runtime', 'inProgress') } });
    await sendTokenUsage(h, 'turn_runtime');
    await h.serverSide.send({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { threadId: h.threadId, turn: makeTurn('turn_runtime', 'completed') },
    });
  });

  it('does not continue an unregistered or wrongly registered native command', async () => {
    const h = harness();
    const recorder = recordClientRequests(h.serverSide);
    try {
      const run = h.session.runTurn('do not monitor');
      const initial = await recorder.waitFor((request) => request.method === 'turn/start');
      await h.serverSide.send({ jsonrpc: '2.0', id: initial.id, result: { turn: makeTurn('turn_1', 'inProgress') } });
      await flushMicrotasks();
      await h.serverSide.send({
        jsonrpc: '2.0', method: 'item/started',
        params: { threadId: h.threadId, turnId: 'turn_1', item: runningNativeCommand('cmd_1') },
      });
      await h.serverSide.send({
        jsonrpc: '2.0', method: 'item/started',
        params: { threadId: h.threadId, turnId: 'turn_1', item: nativeCompletionRegistration('reg_wrong', 'not-the-handle') },
      });
      await h.serverSide.send({
        jsonrpc: '2.0', method: 'item/completed',
        params: { threadId: h.threadId, turnId: 'turn_1', item: completedNativeCommand('cmd_1') },
      });
      await sendTokenUsage(h, 'turn_1');
      await h.serverSide.send({
        jsonrpc: '2.0', method: 'turn/completed',
        params: { threadId: h.threadId, turn: makeTurn('turn_1', 'completed') },
      });
      await run;
      await flushMicrotasks();

      expect(recorder.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    } finally {
      recorder.unsubscribe();
    }
  });

  it('suppresses a registered completion immediately on manual interruption', async () => {
    const h = harness();
    const recorder = recordClientRequests(h.serverSide);
    try {
      const run = h.session.runTurn('monitor then stop');
      const initial = await recorder.waitFor((request) => request.method === 'turn/start');
      await h.serverSide.send({ jsonrpc: '2.0', id: initial.id, result: { turn: makeTurn('turn_1', 'inProgress') } });
      await flushMicrotasks();
      await h.serverSide.send({
        jsonrpc: '2.0', method: 'item/started',
        params: { threadId: h.threadId, turnId: 'turn_1', item: runningNativeCommand('cmd_1') },
      });
      await h.serverSide.send({
        jsonrpc: '2.0', method: 'item/started',
        params: { threadId: h.threadId, turnId: 'turn_1', item: nativeCompletionRegistration('reg_1', '777') },
      });
      h.session.interrupt();
      const interrupt = await recorder.waitFor((request) => request.method === 'turn/interrupt');
      await h.serverSide.send({ jsonrpc: '2.0', id: interrupt.id, result: {} });
      await run;
      await h.serverSide.send({
        jsonrpc: '2.0', method: 'item/completed',
        params: { threadId: h.threadId, turnId: 'turn_1', item: completedNativeCommand('cmd_1') },
      });
      await flushMicrotasks();

      expect(recorder.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    } finally {
      recorder.unsubscribe();
    }
  });
});

describe('native completion payload and switch', () => {
  it('keeps completion data bounded and enables only the verified Codex schema line', () => {
    const completion: ReadyNativeExecCompletion = {
      eventId: 'event_1', threadId: 'thr_1', originTurnId: 'turn_1', commandExecutionId: 'cmd_1',
      command: 'echo done', cwd: '/repo', processHandle: null, status: 'failed', exitCode: 2,
      durationMs: 42, aggregatedOutput: 'x'.repeat(4_001),
    };
    expect(nativeCompletionEnvelope([completion])).toMatchObject({
      events: [expect.objectContaining({
        status: 'failed',
        output: expect.objectContaining({ excerptTruncatedByQuicksave: true }),
      })],
    });
    expect(isNativeCompletionFeatureEnabled({})).toBe(true);
    expect(isNativeCompletionFeatureEnabled({ QUICKSAVE_CODEX_BACKGROUND_COMPLETIONS: '0' })).toBe(false);
    expect(supportsNativeCompletionProtocol('0.153.4')).toBe(true);
    expect(supportsNativeCompletionProtocol('0.153.9')).toBe(true);
    expect(supportsNativeCompletionProtocol('0.152.9')).toBe(false);
    expect(supportsNativeCompletionProtocol('0.154.0')).toBe(false);
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

function recordClientRequests(serverSide: InMemoryTransport): {
  requests: WireRequest[];
  waitFor(predicate: (request: WireRequest) => boolean): Promise<WireRequest>;
  unsubscribe(): void;
} {
  const requests: WireRequest[] = [];
  const waiters = new Set<{
    predicate: (request: WireRequest) => boolean;
    resolve: (request: WireRequest) => void;
  }>();
  const unsubscribe = serverSide.onMessage((message) => {
    if (!('id' in message && 'method' in message)) return;
    const request = message as WireRequest;
    requests.push(request);
    for (const waiter of waiters) {
      if (!waiter.predicate(request)) continue;
      waiters.delete(waiter);
      waiter.resolve(request);
    }
  });
  return {
    requests,
    waitFor(predicate) {
      const existing = requests.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        waiters.add({ predicate, resolve });
      });
    },
    unsubscribe,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function resolvesWithin<T>(promise: Promise<T>, ms = 100): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`promise did not resolve within ${ms}ms`)), ms);
    }),
  ]);
}

async function sendTokenUsage(h: ReturnType<typeof harness>, turnId: string): Promise<void> {
  await h.serverSide.send({
    jsonrpc: '2.0',
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: h.threadId,
      turnId,
      tokenUsage: makeUsage(makeBreakdown(1, 1), makeBreakdown(1, 1)),
    },
  });
  await flushMicrotasks();
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

function makeTurn(
  id: string,
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress',
) {
  return {
    id,
    items: [],
    itemsView: { type: 'full' },
    status,
    error: null,
    startedAt: 0,
    completedAt: status === 'inProgress' ? null : 1,
    durationMs: status === 'inProgress' ? null : 1,
  };
}

function runningNativeCommand(id: string) {
  return {
    type: 'commandExecution' as const,
    id,
    pluginId: null,
    scriptPath: null,
    command: 'sleep 3; printf done',
    cwd: '/repo',
    processId: '777',
    source: 'unifiedExecStartup' as const,
    status: 'inProgress' as const,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
}

function completedNativeCommand(id: string) {
  return {
    ...runningNativeCommand(id),
    status: 'completed' as const,
    aggregatedOutput: 'done\n',
    exitCode: 0,
    durationMs: 3_000,
  };
}

function nativeCompletionRegistration(id: string, processHandle: string) {
  return {
    type: 'mcpToolCall' as const,
    id,
    server: 'quicksave-sandbox',
    tool: 'RegisterBackgroundExecutionCompletion',
    status: 'inProgress' as const,
    arguments: { processHandle },
    appContext: null,
    appName: null,
    appToolName: null,
    mcpAppResourceUri: null,
    pluginId: null,
    readOnlyHint: true,
    result: null,
    error: null,
    durationMs: null,
  };
}
