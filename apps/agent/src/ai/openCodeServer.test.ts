// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
//
// Tests for openCodeServer env knobs.
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildAutoReviewPermissionRuleset,
  buildOpenCodeV2PromptInput,
  getOpenCodeServer,
  _resetOpenCodeServer,
  getOpenCodeCompactTimeoutMs,
} from './openCodeServer.js';
import {
  UPDATE_SESSION_STATUS_TOOL,
  DISPLAY_MARKDOWN_REPORT_TOOL,
  REGISTER_BACKGROUND_EXECUTION_COMPLETION_TOOL,
} from './quicksaveToolsMcp.js';

const ENV_KEY = 'QUICKSAVE_OPENCODE_COMPACT_TIMEOUT_MS';

afterEach(() => {
  delete process.env[ENV_KEY];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetOpenCodeServer();
});

describe('OpenCode V2 prompt admission', () => {
  it('maps attachments to V2 file URIs without changing the legacy parts format', () => {
    expect(buildOpenCodeV2PromptInput('inspect', [{
      id: 'att_1', kind: 'image', mimeType: 'image/png', name: 'screen.png',
      size: 3, data: 'YWJj',
    }])).toEqual({
      text: 'inspect',
      files: [{ uri: 'data:image/png;base64,YWJj', name: 'screen.png' }],
    });
  });

  it.each(['queue', 'steer'] as const)('posts %s to the V2 admission route', async (delivery) => {
    const server = getOpenCodeServer();
    vi.spyOn(server, 'ensureRunning').mockResolvedValue({ baseUrl: 'http://127.0.0.1:4096' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 'msg_v2', admittedSeq: 7 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(server.sendV2Prompt('ses_v2', { text: 'next', delivery }))
      .resolves.toEqual({ id: 'msg_v2', admittedSeq: 7 });
    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/session/ses_v2/prompt');
    expect(request.method).toBe('POST');
    expect(JSON.parse(String(request.body))).toEqual({
      prompt: { text: 'next' }, delivery, resume: true,
    });
  });
});

describe('getOpenCodeCompactTimeoutMs', () => {
  it('defaults to 600s when unset', () => {
    delete process.env[ENV_KEY];
    expect(getOpenCodeCompactTimeoutMs()).toBe(600_000);
  });

  it('honors a valid env override', () => {
    process.env[ENV_KEY] = '900000';
    expect(getOpenCodeCompactTimeoutMs()).toBe(900_000);
  });

  it('falls back to the default on non-numeric or non-positive values', () => {
    process.env[ENV_KEY] = 'abc';
    expect(getOpenCodeCompactTimeoutMs()).toBe(600_000);
    process.env[ENV_KEY] = '0';
    expect(getOpenCodeCompactTimeoutMs()).toBe(600_000);
    process.env[ENV_KEY] = '-5000';
    expect(getOpenCodeCompactTimeoutMs()).toBe(600_000);
  });
});

describe('buildAutoReviewPermissionRuleset', () => {
  it('asks for every unknown permission and only allows explicit safe categories', () => {
    expect(buildAutoReviewPermissionRuleset()).toEqual([
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: 'grep', pattern: '*', action: 'allow' },
      { permission: 'glob', pattern: '*', action: 'allow' },
      { permission: 'list', pattern: '*', action: 'allow' },
      { permission: 'lsp', pattern: '*', action: 'allow' },
      { permission: 'todowrite', pattern: '*', action: 'allow' },
      { permission: 'question', pattern: '*', action: 'allow' },
      { permission: 'doom_loop', pattern: '*', action: 'allow' },
      { permission: UPDATE_SESSION_STATUS_TOOL, pattern: '*', action: 'allow' },
      { permission: DISPLAY_MARKDOWN_REPORT_TOOL, pattern: '*', action: 'allow' },
      { permission: REGISTER_BACKGROUND_EXECUTION_COMPLETION_TOOL, pattern: '*', action: 'allow' },
    ]);
  });
});
