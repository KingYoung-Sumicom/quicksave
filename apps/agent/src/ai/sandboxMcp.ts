// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Sandbox MCP constants and spawn-config helper.
 *
 * The actual MCP server is in `sandboxMcpStdio.ts`.
 */

import { existsSync } from 'fs';
import { join } from 'path';

/** MCP server name — tool names appear as `mcp__quicksave-sandbox__<tool>` in canUseTool. */
export const SANDBOX_MCP_NAME = 'quicksave-sandbox';
export const SANDBOX_MCP_PREFIX = `mcp__${SANDBOX_MCP_NAME}__`;
export const SANDBOX_BASH_TOOL = `${SANDBOX_MCP_PREFIX}SandboxBash`;
export const UPDATE_SESSION_STATUS_TOOL = `${SANDBOX_MCP_PREFIX}UpdateSessionStatus`;

export interface SandboxMcpServerConfig {
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
 *      `mcp_servers[quicksave-sandbox].status = "failed"`. The MCP tools then
 *      never reach the model's tool surface and neither `SandboxBash` nor
 *      `UpdateSessionStatus` are callable.
 *
 *   2. Even if tsx were resolvable, running through `npx` pulls npm's warning
 *      output (e.g. the `.npmrc` "Unknown project config" warning) onto stdout.
 *      The MCP protocol uses JSON-RPC over stdio; any non-JSON line before the
 *      handshake reply corrupts the stream and the CLI tears the server down.
 *
 * So: resolve `tsx` by absolute path relative to the agent package. Behavior
 * is pinned by `sandboxMcp.test.ts`; break it and tests fail.
 */
export function buildSandboxMcpServerConfig(opts: {
  /** The provider's own dir — `dirname(fileURLToPath(import.meta.url))`.
   * Expected to be `apps/agent/src/ai` (dev, tsx) or `apps/agent/dist/ai` (prod, node).
   * Used to locate `sandboxMcpStdio.{ts,js}` and the agent package's node_modules. */
  ownDir: string;
  /** Project directory the MCP server operates in — becomes `--cwd`. */
  cwd: string;
  /** When resuming, lets the server's UpdateSessionStatus dry-run read the registry file. */
  sessionId?: string;
  /** Correlation id for fresh sessions, where `sessionId` isn't known yet at
   *  spawn. Becomes `--corr`; the stdio server resolves its registry file by
   *  matching this against each entry's `mcpCorrId`. See `sandboxMcpStdio.ts`. */
  corrId?: string;
  /** Hide SandboxBash from the MCP inventory. Codex has native shell execution
   *  and only needs UpdateSessionStatus from this server. */
  includeSandboxBash?: boolean;
}): SandboxMcpServerConfig {
  const tsPath = join(opts.ownDir, 'sandboxMcpStdio.ts');
  const jsPath = join(opts.ownDir, 'sandboxMcpStdio.js');
  const hasTs = existsSync(tsPath);

  // Dev: invoke tsx directly by absolute path. See header comment for why
  // `npx tsx` is forbidden here.
  // Prod: the TS source isn't shipped — run the bundled .js with plain `node`.
  const scriptPath = hasTs ? tsPath : jsPath;
  const command = hasTs
    ? join(opts.ownDir, '..', '..', 'node_modules', '.bin', 'tsx')
    : 'node';

  const args = [scriptPath, '--cwd', opts.cwd];
  if (opts.sessionId) args.push('--session-id', opts.sessionId);
  if (opts.corrId) args.push('--corr', opts.corrId);
  if (opts.includeSandboxBash === false) args.push('--no-sandbox-bash');

  return { type: 'stdio', command, args };
}
