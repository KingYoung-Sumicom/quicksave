#!/usr/bin/env npx tsx
// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * CLI tool to read Claude Code session messages via the Agent SDK.
 *
 * Usage:
 *   npx tsx scripts/get-session-messages.ts <sessionId> [options]
 *   npx tsx scripts/get-session-messages.ts --list [--dir <path>]
 *
 * Options:
 *   --list                  List available sessions instead of reading messages
 *   --dir <path>            Project directory to search in
 *   --limit <n>             Max messages to return (default: all)
 *   --offset <n>            Skip first n messages (default: 0)
 *   --include-system        Include system messages (compact boundaries, etc.)
 *   --json                  Output raw JSON instead of formatted text
 *   --role <user|assistant> Filter by message role
 *
 * Examples:
 *   npx tsx scripts/get-session-messages.ts --list
 *   npx tsx scripts/get-session-messages.ts abc123
 *   npx tsx scripts/get-session-messages.ts abc123 --limit 10 --json
 *   npx tsx scripts/get-session-messages.ts abc123 --dir /path/to/project --role user
 */

import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const opts: {
    sessionId?: string;
    list: boolean;
    dir?: string;
    limit?: number;
    offset?: number;
    includeSystem: boolean;
    json: boolean;
    role?: 'user' | 'assistant' | 'system';
  } = { list: false, includeSystem: false, json: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--list':
        opts.list = true;
        break;
      case '--dir':
        opts.dir = args[++i];
        break;
      case '--limit':
        opts.limit = parseInt(args[++i], 10);
        break;
      case '--offset':
        opts.offset = parseInt(args[++i], 10);
        break;
      case '--include-system':
        opts.includeSystem = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--role':
        opts.role = args[++i] as 'user' | 'assistant' | 'system';
        break;
      case '--help':
      case '-h':
        console.log(
          `Usage:\n` +
          `  npx tsx scripts/get-session-messages.ts <sessionId> [options]\n` +
          `  npx tsx scripts/get-session-messages.ts --list [--dir <path>]\n\n` +
          `Options:\n` +
          `  --list                  List available sessions\n` +
          `  --dir <path>            Project directory\n` +
          `  --limit <n>             Max messages to return\n` +
          `  --offset <n>            Skip first n messages\n` +
          `  --include-system        Include system messages\n` +
          `  --json                  Output raw JSON\n` +
          `  --role <user|assistant> Filter by role\n`
        );
        process.exit(0);
        break;
      default:
        if (!arg.startsWith('--') && !opts.sessionId) {
          opts.sessionId = arg;
        } else {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  return opts;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatMessage(msg: { type: string; uuid: string; message: unknown }, index: number): string {
  const roleColors: Record<string, string> = {
    user: '\x1b[36m',      // cyan
    assistant: '\x1b[32m', // green
    system: '\x1b[33m',    // yellow
  };
  const reset = '\x1b[0m';
  const dim = '\x1b[2m';
  const color = roleColors[msg.type] ?? '';

  const header = `${color}[${msg.type.toUpperCase()}]${reset} ${dim}#${index} uuid=${msg.uuid}${reset}`;

  // Extract text content from the message
  const content = extractTextContent(msg.message);
  return `${header}\n${content}\n`;
}

function extractTextContent(message: unknown): string {
  if (!message || typeof message !== 'object') return String(message ?? '');

  const msg = message as Record<string, unknown>;

  // Handle Anthropic message format: { content: [...] }
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block: unknown) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') return b.text;
          if (b.type === 'tool_use') return `[tool_use: ${b.name}(${JSON.stringify(b.input).slice(0, 120)}...)]`;
          if (b.type === 'tool_result') {
            const resultContent = typeof b.content === 'string' ? b.content : JSON.stringify(b.content).slice(0, 200);
            return `[tool_result: ${resultContent}...]`;
          }
        }
        return JSON.stringify(block).slice(0, 200);
      })
      .join('\n');
  }

  // Plain string content
  if (typeof msg.content === 'string') return msg.content;

  return JSON.stringify(message, null, 2).slice(0, 500);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.list) {
    const sessions = await listSessions(opts.dir ? { dir: opts.dir } : undefined);
    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
    } else {
      if (sessions.length === 0) {
        console.log('No sessions found.');
        return;
      }
      console.log(`Found ${sessions.length} session(s):\n`);
      for (const s of sessions) {
        const session = s as Record<string, unknown>;
        const id = session.sessionId ?? 'unknown';
        const title = session.customTitle ?? session.summary ?? session.firstPrompt ?? '';
        const titleStr = String(title).slice(0, 80);
        const modified = session.lastModified
          ? new Date(session.lastModified as number).toLocaleString()
          : '';
        const cwd = session.cwd ?? '';
        console.log(`  ${id}  ${modified}`);
        if (titleStr) console.log(`    ${titleStr}`);
        if (cwd) console.log(`    cwd: ${cwd}`);
        console.log();
      }
    }
    return;
  }

  if (!opts.sessionId) {
    console.error('Error: session ID is required. Use --list to find sessions, or --help for usage.');
    process.exit(1);
  }

  const messages = await getSessionMessages(opts.sessionId, {
    dir: opts.dir,
    limit: opts.limit,
    offset: opts.offset,
    includeSystemMessages: opts.includeSystem,
  });

  let filtered = messages;
  if (opts.role) {
    filtered = messages.filter((m) => m.type === opts.role);
  }

  if (opts.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  console.log(`Session ${opts.sessionId}: ${filtered.length} message(s)\n${'─'.repeat(60)}\n`);
  filtered.forEach((msg, i) => {
    console.log(formatMessage(msg, i));
  });
}

main().catch((err) => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
