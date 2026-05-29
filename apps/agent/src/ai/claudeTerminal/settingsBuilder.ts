// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Generate the `--settings` JSON for a TUI-spawned `claude` so that selected
 * hooks phone home to our daemon's per-session Unix socket via `hookHandler`.
 *
 * The hook contract (Claude Code v2.x): each hook command is a shell command
 * invoked by claude with the hook payload as JSON on stdin. The command's
 * stdout (if it parses as JSON with `hookSpecificOutput.hookEventName === <event>`)
 * is interpreted as a decision; otherwise the hook is informational.
 *
 * We use a `node` invocation pointing at the compiled `hookHandler.js` so we
 * don't depend on `nc -U` (which is missing from many minimal container images).
 */

import type { HookEventName } from './hookBridge.js';

export interface HookSettings {
  /** Absolute path to the compiled hookHandler.js (or .ts when running under tsx). */
  handlerPath: string;
  /** Absolute path to the daemon's per-session Unix socket. */
  socketPath: string;
  /** Hooks to register. */
  events: readonly HookEventName[];
  /** Optional matcher per hook event (defaults to '*' = all tools). */
  matcher?: string;
  /** Optional node binary override (defaults to 'node' on PATH). */
  nodeBin?: string;
}

interface HookSpec {
  matcher: string;
  hooks: Array<{ type: 'command'; command: string }>;
}

/**
 * Build the `{ hooks: { ... } }` block to pass via `--settings`.
 *
 * The same handler script handles every event — claude itself tags the payload
 * with `hook_event_name` so the handler can route. We just need one matching
 * spec per event so claude knows to fire it.
 */
export function buildHookSettings(opts: HookSettings): { hooks: Record<string, HookSpec[]> } {
  const nodeBin = opts.nodeBin ?? 'node';
  const matcher = opts.matcher ?? '*';
  // Quote shell-safely. paths come from us (daemon-generated tmp paths) so they
  // shouldn't contain quotes, but escape just in case.
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const command = `${q(nodeBin)} ${q(opts.handlerPath)} ${q(opts.socketPath)}`;

  const hooks: Record<string, HookSpec[]> = {};
  for (const ev of opts.events) {
    hooks[ev] = [
      {
        matcher,
        hooks: [{ type: 'command', command }],
      },
    ];
  }
  return { hooks };
}
