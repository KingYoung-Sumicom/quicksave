// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Daemon-side Unix socket server that receives hook payloads from
 * `hookHandler` instances spawned by claude. One bridge per provider session
 * — the socket path is unique so multiple sessions don't cross-talk.
 *
 * Protocol (line-delimited JSON):
 *
 *   client → server: { "event": "<HookEventName>", "payload": <hook-json> }
 *   server → client: { "decision": <hookSpecificOutput | null> }
 *
 * The server emits `{ event, payload, respond }` for each request. Listeners
 * call `respond({...})` to fulfil blocking hooks (PermissionRequest); for
 * fire-and-forget hooks (PreToolUse / PostToolUse / Stop) the bridge auto-acks
 * with `{decision: null}` once all listeners settle (or immediately if no
 * listener registers a deferred decision).
 */

import { createServer, type Server, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Hook event names accepted by claude --settings. Subset matches what we
 * observed in the bundled cli.js v2.1.111+:
 *   PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit,
 *   SessionStart, Stop, SubagentStop, Notification
 */
export type HookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PermissionRequest'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'Stop'
  | 'SubagentStop'
  | 'Notification';

export interface HookRequest {
  event: HookEventName;
  payload: Record<string, unknown>;
  /** Resolve the hook with a decision object. Calling more than once is a
   *  no-op (first wins) — claude only reads one response line. */
  respond: (decision: HookDecision) => void;
}

/** What we send back to claude on the hook stdout. */
export type HookDecision = HookSpecificOutput | null;

/** Shape claude expects for actionable hook responses. */
export interface HookSpecificOutput {
  hookSpecificOutput?: {
    hookEventName: HookEventName;
    decision?: { behavior: 'allow' | 'deny'; message?: string };
    [k: string]: unknown;
  };
}

/**
 * Hard ceiling on how long the bridge waits for a listener to call respond().
 * 30s is generous — PermissionRequest UI usually answers in under 10s.
 * After this, the bridge replies with `{decision: null}` so claude isn't
 * stuck waiting on stdin forever.
 */
const HOOK_RESPONSE_FALLBACK_MS = 30_000;

export class HookBridge extends EventEmitter {
  readonly socketPath: string;
  private server: Server | null = null;
  /** Bound listener count for emitter — we emit 'request' events. */

  constructor(socketPath?: string) {
    super();
    this.socketPath = socketPath ?? defaultSocketPath();
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* */ }
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((sock) => this.handleConnection(sock));
      server.on('error', reject);
      server.listen(this.socketPath, () => {
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    try { unlinkSync(this.socketPath); } catch { /* */ }
  }

  /** Subscribe to incoming hook requests. */
  onRequest(handler: (req: HookRequest) => void): () => void {
    this.on('request', handler);
    return () => this.off('request', handler);
  }

  private handleConnection(sock: Socket): void {
    let buf = '';
    let responded = false;

    const sendResponse = (decision: HookDecision) => {
      if (responded) return;
      responded = true;
      try {
        sock.write(JSON.stringify({ decision }) + '\n');
      } catch { /* socket closed */ }
      sock.end();
    };

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const newlineIdx = buf.indexOf('\n');
      if (newlineIdx === -1) return;
      const line = buf.slice(0, newlineIdx);
      buf = buf.slice(newlineIdx + 1);

      let parsed: { event?: unknown; payload?: unknown };
      try {
        parsed = JSON.parse(line);
      } catch {
        sendResponse(null);
        return;
      }

      const event = parsed.event;
      const payload = parsed.payload;
      if (typeof event !== 'string' || typeof payload !== 'object' || payload === null) {
        sendResponse(null);
        return;
      }

      const req: HookRequest = {
        event: event as HookEventName,
        payload: payload as Record<string, unknown>,
        respond: sendResponse,
      };

      // Listeners are responsible for calling respond(). Fire-and-forget
      // hooks should respond(null) immediately after recording the event;
      // blocking hooks (PermissionRequest) respond when the user has answered.
      // The fallback timer is a safety net so a buggy listener doesn't hang
      // claude forever.
      if (this.listenerCount('request') === 0) {
        sendResponse(null);
      } else {
        this.emit('request', req);
        setTimeout(() => sendResponse(null), HOOK_RESPONSE_FALLBACK_MS);
      }
    });

    sock.on('error', () => sendResponse(null));
  }
}

function defaultSocketPath(): string {
  return join(tmpdir(), `quicksave-hook-${randomBytes(6).toString('hex')}.sock`);
}
