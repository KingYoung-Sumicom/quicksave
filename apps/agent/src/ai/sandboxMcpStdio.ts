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
import { realpathSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, platform } from 'os';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __ownDir = dirname(fileURLToPath(import.meta.url));

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const cwd = readArg('--cwd') ?? process.cwd();
/** Known only on resume; undefined when the CLI spawns this MCP for a fresh session. */
const sessionIdHint = readArg('--session-id');

const realCwd = realpathSync(cwd);
const realHome = realpathSync(process.env.HOME ?? '/');

const quicksaveHome = process.env.QUICKSAVE_HOME || join(homedir(), '.quicksave');
const sessionRegistryDir = join(quicksaveHome, 'state', 'session-registry');
/** Same encoding as `apps/agent/src/ai/sessionRegistry.ts:encodeProjectPath`. */
const encodedCwd = cwd.replace(/\//g, '-');

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

/**
 * Snapshot returned to the agent as a tool result. Contains a trimmed view
 * of the stored `SessionRegistryEntry` — enough for the agent to decide
 * whether to update subject/stage/etc., without leaking registry internals.
 */
interface StatusSnapshot {
  subject: string | null;
  stage: 'investigating' | 'working' | 'verifying' | 'done' | null;
  blocked: boolean | null;
  note: string | null;
  /** Last 5 entries of the append-only event log (oldest first). */
  recentNotes: Array<{ ts: number; text: string }>;
  /** 'stored' = read from registry file, 'unknown' = no file / no session-id hint */
  source: 'stored' | 'unknown';
}

function readStoredStatus(): StatusSnapshot {
  const empty: StatusSnapshot = {
    subject: null, stage: null, blocked: null, note: null, recentNotes: [], source: 'unknown',
  };
  if (!sessionIdHint) return empty;
  const path = join(sessionRegistryDir, encodedCwd, `${sessionIdHint}.json`);
  if (!existsSync(path)) return empty;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const history = Array.isArray(entry.noteHistory) ? entry.noteHistory as Array<{ ts: number; text: string }> : [];
    return {
      subject: typeof entry.title === 'string' ? entry.title : null,
      stage: (entry.stage as StatusSnapshot['stage']) ?? null,
      blocked: typeof entry.blocked === 'boolean' ? entry.blocked : null,
      note: typeof entry.note === 'string' ? entry.note : null,
      recentNotes: history.slice(-5),
      source: 'stored',
    };
  } catch {
    return empty;
  }
}

server.tool(
  'UpdateSessionStatus',
  'Update the ticket-style status for the current session, shown to the user on the home screen.\n' +
    '\n' +
    'Call at the START of every session (first response), and again whenever stage changes, ' +
    'work gets blocked/unblocked, or progress is worth surfacing.\n' +
    '\n' +
    'Call with NO fields to read the current stored status without mutating ' +
    '(dry-run). Useful on resume to check whether subject/stage already match the work.\n' +
    '\n' +
    'Fields:\n' +
    '  subject — What this session is solving, from the user\'s perspective.\n' +
    '            Good: "Fix auth token expiring early"   Bad: "Debugging jwt.ts"\n' +
    '  stage   — Ticket lifecycle stage:\n' +
    '            investigating  reading code, finding root cause, understanding problem, designing\n' +
    '            working        actively writing or changing code\n' +
    '            verifying      running tests, confirming the fix, waiting on CI\n' +
    '            done           user-visible deliverable is complete\n' +
    '  blocked — Orthogonal flag. Set true when stuck (waiting on user decision, ' +
    'permission request, external service). Set false when unblocked. Do not change stage.\n' +
    '  note    — One progress/finding entry, max ~12 words. APPENDED to the session\'s event log ' +
    '(not overwritten). Emit one on meaningful state changes: ruling out a hypothesis, ' +
    'completing a sub-goal, hitting a blocker, starting verification, etc. ' +
    'Examples: "handler done, writing tests" / "permission pending on git push" / ' +
    '"ruled out jwt.ts — secret looks right".\n' +
    '\n' +
    'Typical flows:\n' +
    '  Bug / debug:    investigating → working → verifying → (loop or done)\n' +
    '  Feature:        investigating → working → verifying → done\n' +
    '  Question:       investigating → done\n' +
    '  Chore:          working → verifying → done\n' +
    '\n' +
    'Rules:\n' +
    '- Always call on the first response of a new session to set `subject` and `stage`.\n' +
    '- On resume, if you cannot see a prior UpdateSessionStatus tool call in conversation ' +
    'history, do a no-args dry-run first; then set/correct subject or stage if blank or ' +
    'drifted from the current work.\n' +
    '- For long-running tasks (research, large refactors), emit a `note` every time you ' +
    'cross a sub-goal or learn something — the user opens the session to skim recent notes ' +
    'as progress signal.\n' +
    '- Do not skip `verifying` if you ran tests / build / repro.\n' +
    '- Do not declare `done` until the user\'s problem is fully resolved.\n' +
    '- For long refactors, prefer proposing to split into per-phase sub-sessions ' +
    'over keeping one session in `investigating` for a long time.',
  {
    subject: z.string().optional().describe('Subject line — what this session is solving'),
    stage: z.enum(['investigating', 'working', 'verifying', 'done']).optional()
      .describe('Current lifecycle stage'),
    blocked: z.boolean().optional().describe('True when stuck, false when unblocked'),
    note: z.string().optional()
      .describe('One progress/finding entry (~12 words). Appended to the session event log; emit on each meaningful state change.'),
  },
  async (args) => {
    const isDryRun =
      args.subject === undefined &&
      args.stage === undefined &&
      args.blocked === undefined &&
      args.note === undefined;

    // Daemon-side `shouldAutoApprove` has already persisted any updates by the
    // time this handler runs, so re-reading the registry file yields the final
    // merged state for both dry-run and write paths.
    const snapshot = readStoredStatus();

    const header = isDryRun
      ? (snapshot.source === 'stored' ? 'Current session status (dry-run read):' : 'No stored status for this session yet.')
      : 'Session status updated. Current status:';

    return {
      content: [{
        type: 'text' as const,
        text: `${header}\n${JSON.stringify(snapshot, null, 2)}`,
      }],
    };
  },
);

/** Quote a string for safe use inside a bash -c argument. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const transport = new StdioServerTransport();
await server.connect(transport);
