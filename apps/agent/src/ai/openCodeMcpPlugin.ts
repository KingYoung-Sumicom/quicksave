// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
//
// OpenCode MCP tools are workspace-scoped, while Quicksave session metadata
// must be written to exactly one session. OpenCode's tool hook knows the
// sessionID, so inject it into Quicksave MCP calls immediately before
// execution. The MCP schema accepts this private host-only argument.

export const OPENCODE_QUICKSAVE_MCP_PREFIX = 'mcp__quicksave-sandbox__';
export const QUICKSAVE_SESSION_ID_ARG = '_quicksaveSessionId';

export interface OpenCodeToolHookInput {
  tool: string;
  sessionID: string;
  callID: string;
}

export interface OpenCodeToolHookOutput {
  args: Record<string, unknown>;
}

export async function injectQuicksaveSessionId(
  input: OpenCodeToolHookInput,
  output: OpenCodeToolHookOutput,
): Promise<void> {
  if (!input.tool.startsWith(OPENCODE_QUICKSAVE_MCP_PREFIX)) return;
  output.args[QUICKSAVE_SESSION_ID_ARG] = input.sessionID;
}

const plugin = {
  id: 'quicksave-mcp-context',
  server: async () => ({
    'tool.execute.before': injectQuicksaveSessionId,
  }),
};

export default plugin;
