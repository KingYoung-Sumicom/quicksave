// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ChildProcess } from 'node:child_process';

import type { RpcTransport, WireMessage } from './rpcClient.js';

/**
 * Stdio transport for the codex `app-server` child process. Frames
 * messages as JSONL on stdin/stdout — one JSON object per line.
 *
 * This wrapper is intentionally narrow: it does NOT spawn the child
 * (that's `processManager.ts`) or run the JSON-RPC protocol (that's
 * `rpcClient.ts`). It just translates between line-buffered JSON and
 * structured messages.
 */
export class StdioTransport implements RpcTransport {
  private readonly child: ChildProcess;
  private readonly messageListeners = new Set<(m: WireMessage) => void>();
  private readonly closeListeners = new Set<(reason: Error | null) => void>();
  private closed = false;
  private frame = '';
  private frameDepth = 0;
  private frameInString = false;
  private frameEscaped = false;
  /** Logger for parse failures and stderr lines. The default no-ops so
   * tests stay quiet; real users should pass a console-bound logger. */
  private readonly log: { warn: (msg: string) => void };

  constructor(child: ChildProcess, opts: { log?: { warn: (msg: string) => void } } = {}) {
    if (!child.stdin || !child.stdout) {
      throw new Error('StdioTransport requires a child process with stdin and stdout pipes');
    }
    this.child = child;
    this.log = opts.log ?? { warn: () => {} };

    child.stdout.on('data', (chunk: Buffer) => this.handleChunk(chunk.toString('utf8')));
    child.stdout.on('end', () => this.handleClose(null));

    child.on('exit', (code, signal) => {
      const reason =
        code === 0 || code === null
          ? null
          : new Error(`codex app-server exited with code=${code} signal=${signal ?? 'none'}`);
      this.handleClose(reason);
    });

    child.on('error', (err) => this.handleClose(err));
  }

  async send(message: WireMessage): Promise<void> {
    if (this.closed) throw new Error('stdio transport closed');
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw new Error('stdio transport stdin unavailable');
    const line = JSON.stringify(message) + '\n';
    return new Promise<void>((resolve, reject) => {
      stdin.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  onMessage(listener: (message: WireMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (reason: Error | null) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.handleClose(null);
    try {
      this.child.stdin?.end();
    } catch {
      // best-effort
    }
  }

  /**
   * Codex normally emits JSONL, but 0.149 can emit an old thread's very long
   * history with literal newlines inside a JSON string. Frame by JSON nesting
   * rather than by line, then repair only those illegal control characters.
   */
  private handleChunk(chunk: string): void {
    for (const char of chunk) {
      if (this.frameDepth === 0) {
        if (char === '{' || char === '[') {
          this.frame = char;
          this.frameDepth = 1;
          this.frameInString = false;
          this.frameEscaped = false;
        }
        continue;
      }

      this.frame += char;
      if (this.frameInString) {
        if (this.frameEscaped) this.frameEscaped = false;
        else if (char === '\\') this.frameEscaped = true;
        else if (char === '"') this.frameInString = false;
        continue;
      }
      if (char === '"') this.frameInString = true;
      else if (char === '{' || char === '[') this.frameDepth += 1;
      else if (char === '}' || char === ']') {
        this.frameDepth -= 1;
        if (this.frameDepth === 0) {
          const frame = this.frame;
          this.frame = '';
          this.handleFrame(frame);
        }
      }
    }
  }

  private handleFrame(frame: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(sanitizeJsonStringControls(frame));
    } catch (err) {
      this.log.warn(
        `codex app-server: failed to parse JSON-RPC frame: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.log.warn(`codex app-server: ignoring non-object JSON-RPC line: ${typeof parsed}`);
      return;
    }
    for (const l of this.messageListeners) {
      try {
        l(parsed as WireMessage);
      } catch {
        // listeners must not throw; swallow.
      }
    }
  }

  private handleClose(reason: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.closeListeners) {
      try {
        l(reason);
      } catch {
        // swallow
      }
    }
    this.messageListeners.clear();
    this.closeListeners.clear();
  }
}

function sanitizeJsonStringControls(value: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (inString && !escaped && char.charCodeAt(0) < 0x20) {
      out += char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    out += char;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    }
  }
  return out;
}
