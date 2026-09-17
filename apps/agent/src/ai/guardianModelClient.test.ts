// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { callGuardianModel, probeGuardianModel } from './guardianModelClient.js';
import { getGuardianServerState, resetGuardianServerState } from './guardianServerState.js';

const SCHEMA = { type: 'object', properties: { outcome: { type: 'string' } } };

describe('callGuardianModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts an OpenAI-compatible chat completion request and parses JSON content', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://localhost:8000/v1/chat/completions');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('reviewer-model');
      expect(body.messages).toEqual([
        { role: 'system', content: 'policy' },
        { role: 'user', content: 'review this' },
      ]);
      expect(body.response_format.type).toBe('json_schema');
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(init.headers).toMatchObject({ authorization: 'Bearer sk-test' });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"outcome":"allow"}' } }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callGuardianModel({
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'sk-test',
      model: 'reviewer-model',
      enableThinking: false,
      systemPrompt: 'policy',
      userMessage: 'review this',
      schema: SCHEMA,
    });

    expect(result).toEqual({ outcome: 'allow' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes the configured thinking mode to compatible model servers', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await callGuardianModel({
      baseUrl: 'http://x/v1', model: 'm', enableThinking: true,
      systemPrompt: 's', userMessage: 'u', schema: SCHEMA,
    });
  });

  it('strips a trailing slash from baseUrl', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://localhost:8000/v1/chat/completions');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await callGuardianModel({
      baseUrl: 'http://localhost:8000/v1/',
      model: 'm',
      systemPrompt: 's',
      userMessage: 'u',
      schema: SCHEMA,
    });
  });

  it('omits the authorization header when no apiKey is given', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).not.toHaveProperty('authorization');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await callGuardianModel({ baseUrl: 'http://x/v1', model: 'm', systemPrompt: 's', userMessage: 'u', schema: SCHEMA });
  });

  it('returns raw text when the content is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'not json at all' } }],
    }), { status: 200 })));

    const result = await callGuardianModel({
      baseUrl: 'http://x/v1', model: 'm', systemPrompt: 's', userMessage: 'u', schema: SCHEMA,
    });
    expect(result).toBe('not json at all');
  });

  it('throws on a non-OK HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server exploded', { status: 500 })));

    await expect(callGuardianModel({
      baseUrl: 'http://x/v1', model: 'm', systemPrompt: 's', userMessage: 'u', schema: SCHEMA,
    })).rejects.toThrow(/guardian model server 500/);
  });

  it('throws on an empty completion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' } }],
    }), { status: 200 })));

    await expect(callGuardianModel({
      baseUrl: 'http://x/v1', model: 'm', systemPrompt: 's', userMessage: 'u', schema: SCHEMA,
    })).rejects.toThrow(/empty completion/);
  });

  it('throws when choices are missing entirely', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));

    await expect(callGuardianModel({
      baseUrl: 'http://x/v1', model: 'm', systemPrompt: 's', userMessage: 'u', schema: SCHEMA,
    })).rejects.toThrow(/empty completion/);
  });

  it('marks the daemon-wide server state ok on a successful review', async () => {
    resetGuardianServerState();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"outcome":"allow"}' } }],
    }), { status: 200 })));

    await callGuardianModel({
      baseUrl: 'http://x/v1', model: 'm', systemPrompt: 's', userMessage: 'u', schema: SCHEMA,
    });
    expect(getGuardianServerState()).toMatchObject({ status: 'ok' });
  });

  it('marks the daemon-wide server state failed with the reason on an HTTP error', async () => {
    resetGuardianServerState();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    await expect(callGuardianModel({
      baseUrl: 'http://x/v1', model: 'm', systemPrompt: 's', userMessage: 'u', schema: SCHEMA,
    })).rejects.toThrow(/guardian model server 500/);
    expect(getGuardianServerState()).toMatchObject({ status: 'failed', lastError: expect.stringContaining('guardian model server 500') });
  });

  it('marks the daemon-wide server state failed on a transport error', async () => {
    resetGuardianServerState();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    await expect(callGuardianModel({
      baseUrl: 'http://x/v1', model: 'm', systemPrompt: 's', userMessage: 'u', schema: SCHEMA,
    })).rejects.toThrow(/ECONNREFUSED/);
    expect(getGuardianServerState()).toMatchObject({ status: 'failed', lastError: 'ECONNREFUSED' });
  });
});

describe('probeGuardianModel', () => {
  beforeEach(() => {
    resetGuardianServerState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const CONFIG = { baseUrl: 'http://localhost:8000/v1', model: 'reviewer' };

  it('returns ok with a latency and marks the server state ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://localhost:8000/v1/chat/completions');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('reviewer');
      expect(body.max_tokens).toBe(1);
      expect(body.response_format).toBeUndefined();
      return new Response('{}', { status: 200 });
    }));

    const result = await probeGuardianModel(CONFIG, 5_000);
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
    expect(getGuardianServerState()).toMatchObject({ status: 'ok' });
  });

  it('strips trailing slashes and omits the auth header without an API key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).not.toHaveProperty('authorization');
      return new Response('{}', { status: 200 });
    }));
    await expect(probeGuardianModel({ baseUrl: 'http://localhost:8000/v1/', model: 'm' }, 5_000)).resolves.toMatchObject({ ok: true });
  });

  it('sends the draft API key as a bearer token', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ authorization: 'Bearer draft-key' });
      return new Response('{}', { status: 200 });
    }));
    await expect(probeGuardianModel({ baseUrl: 'http://x/v1', model: 'm', apiKey: 'draft-key' }, 5_000)).resolves.toMatchObject({ ok: true });
  });

  it('reports the HTTP error and marks the server state failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('service unavailable', { status: 503 })));

    const result = await probeGuardianModel(CONFIG, 5_000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/guardian model server 503/);
    expect(getGuardianServerState()).toMatchObject({ status: 'failed', lastError: expect.stringContaining('503') });
  });

  it('does not record draft probes when recordState is false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 500 })));

    const result = await probeGuardianModel({ baseUrl: 'http://draft/v1', model: 'draft' }, 5_000, false);
    expect(result.ok).toBe(false);
    expect(getGuardianServerState()).toEqual({ status: 'unknown' });
  });

  it('times out the probe and reports a timeout error', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })));

    const result = await probeGuardianModel(CONFIG, 30);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('guardian model server timed out');
    expect(getGuardianServerState()).toMatchObject({ status: 'failed', lastError: 'guardian model server timed out' });
  });
});
