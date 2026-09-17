// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from 'vitest';
import { callGuardianModel } from './guardianModelClient.js';

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
});
