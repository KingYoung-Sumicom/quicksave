import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

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
  /** Logger for parse failures and stderr lines. The default no-ops so
   * tests stay quiet; real users should pass a console-bound logger. */
  private readonly log: { warn: (msg: string) => void };

  constructor(child: ChildProcess, opts: { log?: { warn: (msg: string) => void } } = {}) {
    if (!child.stdin || !child.stdout) {
      throw new Error('StdioTransport requires a child process with stdin and stdout pipes');
    }
    this.child = child;
    this.log = opts.log ?? { warn: () => {} };

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(line));
    rl.on('close', () => this.handleClose(null));

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

  private handleLine(line: string): void {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.log.warn(
        `codex app-server: failed to parse JSON-RPC line: ${err instanceof Error ? err.message : String(err)}`,
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
