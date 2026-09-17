// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Quicksave tools MCP constants and spawn-config helper.
 *
 * The actual MCP server is in `quicksaveToolsMcpStdio.ts`.
 */

import { existsSync } from 'fs';
import { join } from 'path';

/** MCP server name — tool names appear as `mcp__quicksave-tools__<tool>` in canUseTool. */
export const QUICKSAVE_MCP_NAME = 'quicksave-tools';
export const QUICKSAVE_MCP_PREFIX = `mcp__${QUICKSAVE_MCP_NAME}__`;
export const UPDATE_SESSION_STATUS_TOOL = `${QUICKSAVE_MCP_PREFIX}UpdateSessionStatus`;
export const DISPLAY_MARKDOWN_REPORT_TOOL = `${QUICKSAVE_MCP_PREFIX}DisplayMarkdownReport`;
/** Codex-only opt-in for a native exec_command completion notification. */
export const REGISTER_BACKGROUND_EXECUTION_COMPLETION_TOOL_NAME = 'RegisterBackgroundExecutionCompletion';
export const REGISTER_BACKGROUND_EXECUTION_COMPLETION_TOOL =
  `${QUICKSAVE_MCP_PREFIX}${REGISTER_BACKGROUND_EXECUTION_COMPLETION_TOOL_NAME}`;

/** Quicksave-owned control-plane tools that never cross a user security
 * boundary and therefore must not be sent to the OpenCode Guardian. Keep
 * this explicit: a future state-changing MCP tool should not inherit the
 * bypass merely because it shares the Quicksave server prefix. */
export const QUICKSAVE_GUARDIAN_BYPASS_TOOLS: readonly string[] = [
  UPDATE_SESSION_STATUS_TOOL,
  DISPLAY_MARKDOWN_REPORT_TOOL,
  REGISTER_BACKGROUND_EXECUTION_COMPLETION_TOOL,
];

export function bypassesQuicksaveGuardian(toolName: string | undefined): boolean {
  return typeof toolName === 'string' && QUICKSAVE_GUARDIAN_BYPASS_TOOLS.includes(toolName);
}

export interface QuicksaveToolsMcpServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
}

/**
 * Build the stdio MCP server spawn config for the Claude CLI / SDK.
 *
 * ⚠️  DO NOT "simplify" this to `command: 'npx', args: ['tsx', ...]` — that
 * shape looks cleaner but silently fails in our setup. Two reasons:
 *
 *   1. Claude CLI spawns MCP stdio servers with cwd = the user's project dir.
 *      In a pnpm monorepo, `tsx` is installed under `apps/agent/node_modules/
 *      .bin/tsx` (not hoisted to the workspace root). `npx tsx` only searches
 *      upward from cwd for `.bin/tsx`, so from the project root it falls
 *      through to fetching from the npm registry — which in practice exits
 *      with `sh: 1: tsx: not found`, and Claude CLI marks the server
 *      `mcp_servers[quicksave-tools].status = "failed"`. The MCP tools then
 *      never reach the model's tool surface and `UpdateSessionStatus` is not
 *      callable.
 *
 *   2. Even if tsx were resolvable, running through `npx` pulls npm's warning
 *      output (e.g. the `.npmrc` "Unknown project config" warning) onto stdout.
 *      The MCP protocol uses JSON-RPC over stdio; any non-JSON line before the
 *      handshake reply corrupts the stream and the CLI tears the server down.
 *
 * So: resolve `tsx` by absolute path relative to the agent package. Behavior
 * is pinned by `quicksaveToolsMcp.test.ts`; break it and tests fail.
 */
export function buildQuicksaveToolsMcpServerConfig(opts: {
  /** The provider's own dir — `dirname(fileURLToPath(import.meta.url))`.
   * Expected to be `apps/agent/src/ai` (dev, tsx) or `apps/agent/dist/ai` (prod, node).
   * Used to locate `quicksaveToolsMcpStdio.{ts,js}` and the agent package's node_modules. */
  ownDir: string;
  /** Project directory the MCP server operates in — becomes `--cwd`. */
  cwd: string;
  /** Let the MCP process inherit its spawn cwd instead of passing `--cwd`.
   * OpenCode creates one MCP process per workspace and already sets that cwd. */
  inheritCwd?: boolean;
  /** When resuming, lets the server's UpdateSessionStatus dry-run read the registry file. */
  sessionId?: string;
  /** Correlation id for fresh sessions, where `sessionId` isn't known yet at
   *  spawn. Becomes `--corr`; the stdio server resolves its registry file by
   *  matching this against each entry's `mcpCorrId`. See `quicksaveToolsMcpStdio.ts`. */
  corrId?: string;
  /** Expose the Codex-only native completion registration tool. */
  includeNativeCompletionRegistration?: boolean;
}): QuicksaveToolsMcpServerConfig {
  const tsPath = join(opts.ownDir, 'quicksaveToolsMcpStdio.ts');
  const jsPath = join(opts.ownDir, 'quicksaveToolsMcpStdio.js');
  const hasTs = existsSync(tsPath);

  // Dev: invoke tsx directly by absolute path. See header comment for why
  // `npx tsx` is forbidden here.
  // Prod: the TS source isn't shipped — run the bundled .js with plain `node`.
  const scriptPath = hasTs ? tsPath : jsPath;
  const command = hasTs
    ? join(opts.ownDir, '..', '..', 'node_modules', '.bin', 'tsx')
    : 'node';

  const args = [scriptPath];
  if (!opts.inheritCwd) args.push('--cwd', opts.cwd);
  if (opts.sessionId) args.push('--session-id', opts.sessionId);
  if (opts.corrId) args.push('--corr', opts.corrId);
  if (opts.includeNativeCompletionRegistration === true) args.push('--native-completion-registration');

  return { type: 'stdio', command, args };
}
