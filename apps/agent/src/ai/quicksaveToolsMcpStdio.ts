#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/** Quicksave's stdio MCP server for session status and artifact tools. */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import {
  findRegistryPathByCorr,
  findRegistryPathBySessionId,
} from './sessionRegistryLocator.js';
import { publishMarkdownArtifact } from './artifactStore.js';

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const cwd = readArg('--cwd') ?? process.cwd();
/** Known only on resume; undefined when the CLI spawns this MCP for a fresh session. */
const sessionIdHint = readArg('--session-id');
/**
 * Correlation id baked in by the daemon at spawn (`buildQuicksaveToolsMcpServerConfig`).
 * On a fresh session we have no `--session-id`, so we locate our registry entry
 * by scanning the project's files for the one whose `mcpCorrId` matches this.
 * 1:1 with this process, so the match is exact — no "newest file" guessing.
 */
const corrIdHint = readArg('--corr');
const includeNativeCompletionRegistration = process.argv.includes('--native-completion-registration');
const QUICKSAVE_SESSION_ID_ARG = '_quicksaveSessionId';
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

const realCwd = realpathSync(cwd);
const quicksaveHome = process.env.QUICKSAVE_HOME || join(homedir(), '.quicksave');
const sessionRegistryDir = join(quicksaveHome, 'state', 'session-registry');
/** Same encoding as `apps/agent/src/ai/sessionRegistry.ts:encodeProjectPath`. */
const encodedCwd = cwd.replace(/\//g, '-');
const SESSION_NOTE_HISTORY_CAP = 50;

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'quicksave-tools', version: '1.0.0' });

if (includeNativeCompletionRegistration) {
  server.tool(
    'RegisterBackgroundExecutionCompletion',
    'Register one native Codex exec_command process for a future completion notification. ' +
      'Call this only after native exec_command returned a `Process running with session ID <id>` result and only when the user asked to monitor, wait for, or be notified about that process. ' +
      'Pass that exact session ID as processHandle. This tool does not execute, inspect, poll, signal, or alter the process; Quicksave validates the handle against the current native Codex turn before it can notify you.',
    {
      processHandle: z.string().min(1).max(256)
        .describe('Exact opaque session ID returned by native exec_command. It is not an OS PID.'),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async ({ processHandle }) => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          version: 1,
          registration: 'submitted_for_host_validation',
          processHandle,
        }),
      }],
    }),
  );
}

function currentSessionInfo(explicitSessionId?: string): { sessionId: string; cwd: string } | null {
  const path = sessionRegistryPath(explicitSessionId);
  if (path && existsSync(path)) {
    try {
      const entry = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      if (typeof entry.sessionId === 'string' && typeof entry.cwd === 'string') {
        return { sessionId: entry.sessionId, cwd: entry.cwd };
      }
    } catch {
      return null;
    }
  }
  const fallbackSessionId = validSessionId(explicitSessionId) ?? validSessionId(sessionIdHint);
  if (fallbackSessionId) return { sessionId: fallbackSessionId, cwd: realCwd };
  return null;
}

server.tool(
  'DisplayMarkdownReport',
  'Display a generated Markdown report to the user as a visible Quicksave chat message/artifact card. ' +
    'Use this when you have written a Markdown report that the user should read in the UI, especially when the report is long, data-heavy, or wasteful to repeat in the assistant message. ' +
    'First write the report to a .md or .markdown file inside the project directory, then call this tool with that file path. ' +
    'Quicksave copies the file into artifact storage, renders it in the chat UI, and returns only a small artifact reference. ' +
    'After calling this tool, do not paste the full report into your assistant response; briefly mention that the report is shown in the artifact card.',
  {
    path: z.string().describe('Path to a generated .md/.markdown report inside the project directory. Relative paths resolve from the project cwd.'),
    title: z.string().optional().describe('User-facing report title shown on the artifact card. Defaults to the file name.'),
    [QUICKSAVE_SESSION_ID_ARG]: z.string().regex(SESSION_ID_RE).optional()
      .describe('Injected by the Quicksave OpenCode host. Do not set manually.'),
  },
  {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  async (args) => {
    const session = currentSessionInfo(args[QUICKSAVE_SESSION_ID_ARG]);
    if (!session) {
      return {
        content: [{
          type: 'text' as const,
          text: 'DisplayMarkdownReport failed: no session registry entry is available yet. Try again after the session is fully initialized.',
        }],
        isError: true,
      };
    }
    try {
      const artifact = await publishMarkdownArtifact({
        sessionId: session.sessionId,
        cwd: session.cwd,
        sourcePath: args.path,
        title: args.title,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(artifact),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to display markdown report';
      return {
        content: [{ type: 'text' as const, text: `DisplayMarkdownReport failed: ${message}` }],
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
  pendingMission: { label: string; until: number; startedAt?: number; dismissedAt?: number } | null;
  /** Last 5 entries of the append-only event log (oldest first). */
  recentNotes: Array<{ ts: number; text: string }>;
  /** 'stored' = read from registry file, 'unknown' = no file / no session-id hint */
  source: 'stored' | 'unknown';
}

function readStoredStatus(explicitSessionId?: string): StatusSnapshot {
  const empty: StatusSnapshot = {
    subject: null, stage: null, blocked: null, note: null, pendingMission: null, recentNotes: [], source: 'unknown',
  };
  const path = sessionRegistryPath(explicitSessionId);
  if (!path || !existsSync(path)) return empty;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const history = Array.isArray(entry.noteHistory) ? entry.noteHistory as Array<{ ts: number; text: string }> : [];
    const mission = entry.pendingMission as StatusSnapshot['pendingMission'];
    return {
      subject: typeof entry.title === 'string' ? entry.title : null,
      stage: (entry.stage as StatusSnapshot['stage']) ?? null,
      blocked: typeof entry.blocked === 'boolean' ? entry.blocked : null,
      note: typeof entry.note === 'string' ? entry.note : null,
      pendingMission: mission && typeof mission.label === 'string' && typeof mission.until === 'number' ? mission : null,
      recentNotes: history.slice(-5),
      source: 'stored',
    };
  } catch {
    return empty;
  }
}

/** Resolved registry path, memoized once we successfully locate it via corr. */
let resolvedRegistryPath: string | null = null;
const resolvedRegistryPathsBySession = new Map<string, string>();

/**
 * Locate this session's registry file.
 *
 *  - On resume we're given `--session-id`, so the path is direct.
 *  - On a fresh session we only have `--corr`; scan the project's registry
 *    files for the one whose `mcpCorrId` matches and memoize it (the daemon
 *    stamps `mcpCorrId` onto the entry once it learns the real sessionId, so
 *    the file may not exist on the very first call — we just retry next time).
 *
 * The corr match is exact and 1:1 with this process, so it's safe even when
 * several sessions share a cwd — unlike picking the newest file.
 */
function validSessionId(value: string | undefined): string | undefined {
  return value && SESSION_ID_RE.test(value) ? value : undefined;
}

function sessionRegistryPath(explicitSessionId?: string): string | null {
  const directSessionId = validSessionId(explicitSessionId) ?? validSessionId(sessionIdHint);
  if (directSessionId) {
    const cached = resolvedRegistryPathsBySession.get(directSessionId);
    if (cached && existsSync(cached)) return cached;
    const direct = join(sessionRegistryDir, encodedCwd, `${directSessionId}.json`);
    if (existsSync(direct)) {
      resolvedRegistryPathsBySession.set(directSessionId, direct);
      return direct;
    }
    const found = findRegistryPathBySessionId(sessionRegistryDir, directSessionId);
    if (found) resolvedRegistryPathsBySession.set(directSessionId, found);
    return found;
  }
  if (!corrIdHint) return null;
  if (resolvedRegistryPath && existsSync(resolvedRegistryPath)) return resolvedRegistryPath;
  const found = findRegistryPathByCorr(join(sessionRegistryDir, encodedCwd), corrIdHint);
  if (found) resolvedRegistryPath = found;
  return found;
}

function isSessionStage(value: string): value is NonNullable<StatusSnapshot['stage']> {
  return value === 'investigating' ||
    value === 'working' ||
    value === 'verifying' ||
    value === 'done';
}

function parsePendingMissionUntil(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function writeStoredStatus(args: {
  subject?: string;
  stage?: 'investigating' | 'working' | 'verifying' | 'done';
  blocked?: boolean;
  note?: string;
  pendingMissionLabel?: string;
  pendingMissionUntil?: number | string;
  clearPendingMission?: boolean;
}, explicitSessionId?: string): void {
  const path = sessionRegistryPath(explicitSessionId);
  if (!path || !existsSync(path)) return;

  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }

  let changed = false;
  if (typeof args.subject === 'string' && args.subject.length > 0) {
    entry.title = args.subject;
    changed = true;
  }
  if (typeof args.stage === 'string' && isSessionStage(args.stage)) {
    entry.stage = args.stage;
    if (args.stage === 'done') delete entry.pendingMission;
    changed = true;
  }
  if (typeof args.blocked === 'boolean') {
    entry.blocked = args.blocked;
    changed = true;
  }
  if (args.clearPendingMission === true) {
    delete entry.pendingMission;
    changed = true;
  } else if (args.pendingMissionLabel !== undefined || args.pendingMissionUntil !== undefined) {
    const existing = entry.pendingMission as StatusSnapshot['pendingMission'];
    const label = typeof args.pendingMissionLabel === 'string' && args.pendingMissionLabel.trim().length > 0
      ? args.pendingMissionLabel.trim()
      : existing?.label;
    const until = parsePendingMissionUntil(args.pendingMissionUntil) ?? existing?.until;
    if (label && typeof until === 'number') {
      const isNewSchedule = existing?.label !== label || existing?.until !== until;
      entry.pendingMission = {
        label,
        until,
        startedAt: existing?.startedAt ?? Date.now(),
        ...(isNewSchedule || existing?.dismissedAt === undefined ? {} : { dismissedAt: existing.dismissedAt }),
      };
      changed = true;
    }
  }
  if (typeof args.note === 'string' && args.note.length > 0) {
    entry.note = args.note;
    const prior = Array.isArray(entry.noteHistory)
      ? entry.noteHistory as Array<{ ts: number; text: string }>
      : [];
    const next = [...prior, { ts: Date.now(), text: args.note }];
    entry.noteHistory = next.length > SESSION_NOTE_HISTORY_CAP
      ? next.slice(next.length - SESSION_NOTE_HISTORY_CAP)
      : next;
    changed = true;
  }
  if (!changed) return;

  entry.lastAccessedAt = Date.now();
  writeFileSync(path, JSON.stringify(entry, null, 2));
}

server.tool(
  'UpdateSessionStatus',
  'Update session status shown on the user\'s home screen. MUST call on first response of every session.\n' +
    '\n' +
    'Fields: subject (required on first call), stage (investigating|working|verifying|done), blocked (bool), note (~12 words, appended), pendingMissionLabel, pendingMissionUntil, clearPendingMission.\n' +
    '\n' +
    'Dry-run: call with NO fields to read current status without changing it. Use on resume to check if subject/stage match.\n' +
    '\n' +
    'Flows: Bug=investigating→working→verifying→done. Feature=same. Question=investigating→done. Chore=working→verifying→done.',
  {
    subject: z.string().optional().describe('Subject line — what this session is solving'),
    stage: z.enum(['investigating', 'working', 'verifying', 'done']).optional()
      .describe('Current lifecycle stage'),
    blocked: z.boolean().optional().describe('True when stuck, false when unblocked'),
    note: z.string().optional()
      .describe('One progress/finding entry (~12 words). Appended to the session event log; emit on each meaningful state change.'),
    pendingMissionLabel: z.string().optional().describe('Short label for a long-running task, e.g. "training run"'),
    pendingMissionUntil: z.union([z.number(), z.string()]).optional().describe('Expected completion time as epoch ms or ISO date string'),
    clearPendingMission: z.boolean().optional().describe('Clear the long-running task marker'),
    [QUICKSAVE_SESSION_ID_ARG]: z.string().regex(SESSION_ID_RE).optional()
      .describe('Injected by the Quicksave OpenCode host. Do not set manually.'),
  },
  {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  async (args) => {
    const isDryRun =
      args.subject === undefined &&
      args.stage === undefined &&
      args.blocked === undefined &&
      args.note === undefined &&
      args.pendingMissionLabel === undefined &&
      args.pendingMissionUntil === undefined &&
      args.clearPendingMission === undefined;

    // Codex MCP approval mode "approve" bypasses the daemon permission callback,
    // so this stdio server owns persistence when it has a session-id hint.
    const explicitSessionId = args[QUICKSAVE_SESSION_ID_ARG];
    if (!isDryRun) writeStoredStatus(args, explicitSessionId);

    const snapshot = readStoredStatus(explicitSessionId);

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

const transport = new StdioServerTransport();
await server.connect(transport);
