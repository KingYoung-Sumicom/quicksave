// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  injectQuicksaveSessionId,
  QUICKSAVE_SESSION_ID_ARG,
} from './openCodeMcpPlugin.js';

describe('OpenCode Quicksave MCP plugin', () => {
  it('injects the OpenCode session id into Quicksave MCP calls', async () => {
    const output = { args: { stage: 'working' } };
    await injectQuicksaveSessionId({
      tool: 'mcp__quicksave-sandbox__UpdateSessionStatus',
      sessionID: 'ses_123',
      callID: 'call_1',
    }, output);

    expect(output.args).toEqual({
      stage: 'working',
      [QUICKSAVE_SESSION_ID_ARG]: 'ses_123',
    });
  });

  it('does not modify unrelated tool calls', async () => {
    const output = { args: { filePath: '/tmp/a' } };
    await injectQuicksaveSessionId({
      tool: 'read',
      sessionID: 'ses_123',
      callID: 'call_1',
    }, output);

    expect(output.args).toEqual({ filePath: '/tmp/a' });
  });
});
