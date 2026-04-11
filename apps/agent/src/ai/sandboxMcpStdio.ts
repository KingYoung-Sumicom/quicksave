#!/usr/bin/env node
/**
 * Standalone stdio MCP server for project-scoped sandbox bash.
 *
 * Usage: node sandboxMcpStdio.js --cwd /path/to/project
 *
 * Provides a `SandboxBash` tool that executes shell commands within the given
 * project directory. Designed to be spawned by Claude Code via .mcp.json.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execSync } from 'child_process';
import { z } from 'zod';

const cwdArg = process.argv.indexOf('--cwd');
const cwd = cwdArg !== -1 ? process.argv[cwdArg + 1] : process.cwd();

const server = new McpServer({ name: 'quicksave-sandbox', version: '1.0.0' });

server.tool(
  'SandboxBash',
  'Execute a shell command within the project sandbox. ' +
    'Can read any file on the system, but writes are restricted to the project directory (excluding .git/ folders). ' +
    'Use this for running builds, tests, linters, or any command that needs to modify project files.',
  {
    command: z.string().describe('The shell command to execute'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 120000)'),
  },
  async (args) => {
    try {
      const output = execSync(args.command, {
        cwd,
        encoding: 'utf-8',
        timeout: args.timeout ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { content: [{ type: 'text' as const, text: output || '(no output)' }] };
    } catch (err: any) {
      const stderr = err.stderr ? String(err.stderr) : '';
      const stdout = err.stdout ? String(err.stdout) : '';
      const message = stderr || stdout || err.message || 'Command failed';
      return {
        content: [{ type: 'text' as const, text: message }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
