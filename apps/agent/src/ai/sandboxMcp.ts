/**
 * Sandbox MCP constants.
 *
 * The actual MCP server is in `sandboxMcpStdio.ts`.
 * These constants are used by `claudeCodeService.ts` for tool-name matching.
 */

/** MCP server name — tool names appear as `mcp__quicksave-sandbox__<tool>` in canUseTool. */
export const SANDBOX_MCP_NAME = 'quicksave-sandbox';
export const SANDBOX_MCP_PREFIX = `mcp__${SANDBOX_MCP_NAME}__`;
