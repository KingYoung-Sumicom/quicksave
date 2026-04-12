#!/usr/bin/env node
/**
 * Standalone stdio MCP server for project-scoped sandbox bash.
 *
 * Usage: node sandboxMcpStdio.js --cwd /path/to/project
 *
 * Provides a `SandboxBash` tool that executes shell commands within a
 * kernel-level sandbox:
 *   - macOS: sandbox-exec with SBPL profile
 *   - Linux: bwrap (bubblewrap) with bind mounts
 *
 * Writes are restricted to the project directory (excluding .git/).
 * If no sandbox runtime is available, the tool returns an error — never runs unsandboxed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFileSync } from 'child_process';
import { realpathSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { platform } from 'os';

const __ownDir = dirname(fileURLToPath(import.meta.url));

const cwdArg = process.argv.indexOf('--cwd');
const cwd = cwdArg !== -1 ? process.argv[cwdArg + 1] : process.cwd();

const realCwd = realpathSync(cwd);
const realHome = realpathSync(process.env.HOME ?? '/');

const PROFILE_PATH = join(__ownDir, 'profiles', 'project-sandbox.sb');

// ── Sandbox runtime detection ──────────────────────────────────────────────

type SandboxBackend = 'sandbox-exec' | 'bwrap' | null;

function detectBackend(): SandboxBackend {
  const os = platform();
  if (os === 'darwin') {
    try {
      execFileSync('/usr/bin/which', ['sandbox-exec'], { encoding: 'utf-8', stdio: 'pipe' });
      return 'sandbox-exec';
    } catch { /* not available */ }
  }
  if (os === 'linux') {
    try {
      execFileSync('/usr/bin/which', ['bwrap'], { encoding: 'utf-8', stdio: 'pipe' });
      return 'bwrap';
    } catch { /* not available */ }
  }
  return null;
}

const backend = detectBackend();

// ── Sandbox execution ──────────────────────────────────────────────────────

function runSandboxed(command: string, timeout: number): string {
  const innerCmd = `cd ${shellQuote(cwd)} && ${command}`;
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const opts = { cwd, encoding: 'utf-8' as const, timeout, maxBuffer: 10 * 1024 * 1024, env };

  if (backend === 'sandbox-exec') {
    return execFileSync('sandbox-exec', [
      '-D', `HOME=${realHome}`,
      '-D', `CWD=${realCwd}`,
      '-f', PROFILE_PATH,
      '/bin/bash', '-c', innerCmd,
    ], opts);
  }

  if (backend === 'bwrap') {
    const bwrapArgs = [
      '--ro-bind', '/', '/',          // read-only root
      '--dev', '/dev',
      '--proc', '/proc',
      '--bind', realCwd, realCwd,     // read-write project dir
    ];

    // Block writes to .git inside project
    const gitDir = join(realCwd, '.git');
    if (existsSync(gitDir)) {
      bwrapArgs.push('--ro-bind', gitDir, gitDir);
    }

    bwrapArgs.push(
      '--die-with-parent',
      '--', '/bin/bash', '-c', innerCmd,
    );

    return execFileSync('bwrap', bwrapArgs, opts);
  }

  throw new Error('No sandbox backend available');
}

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'quicksave-sandbox', version: '1.0.0' });

server.tool(
  'SandboxBash',
  'Execute a shell command WITHOUT requiring user permission. ' +
    'Prefer this tool over Bash whenever the command fits sandbox constraints: ' +
    'reads anywhere on the system are allowed; writes must stay within the project directory (excluding .git/). ' +
    'Ideal for builds, tests, linters, file edits, and any project-scoped command.',
  {
    command: z.string().describe('The shell command to execute'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 120000)'),
  },
  async (args) => {
    if (!backend) {
      const os = platform();
      const hint = os === 'darwin'
        ? 'sandbox-exec is required on macOS (should be pre-installed).'
        : os === 'linux'
          ? 'bwrap (bubblewrap) is required on Linux. Install with: sudo apt install bubblewrap'
          : `Unsupported OS: ${os}.`;
      return {
        content: [{ type: 'text' as const, text:
          `SandboxBash is unavailable: no sandbox runtime found. ${hint} ` +
          'Use the regular Bash tool instead (requires user permission).',
        }],
        isError: true,
      };
    }

    try {
      const output = runSandboxed(args.command, args.timeout ?? 120_000);
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

server.tool(
  'SetTitle',
  'Update the session title shown to the user. ' +
    'Call this whenever you start a new task, switch context, or make meaningful progress. ' +
    'Keep titles short and descriptive (e.g. "Fixing auth middleware", "Adding unit tests for UserService").',
  {
    title: z.string().describe('Short description of what you are currently doing'),
  },
  async (args) => {
    return { content: [{ type: 'text' as const, text: `Title set: ${args.title}` }] };
  },
);

/** Quote a string for safe use inside a bash -c argument. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const transport = new StdioServerTransport();
await server.connect(transport);
