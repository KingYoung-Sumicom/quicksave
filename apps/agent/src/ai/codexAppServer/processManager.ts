import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CodexRpcClient } from './rpcClient.js';
import { StdioTransport } from './stdioTransport.js';
import type {
  ClientInfo,
  InitializeCapabilities,
  InitializeResponse,
} from './schema/index.js';
import { CODEX_SCHEMA_PINNED_VERSION } from './version.js';

const execFileAsync = promisify(execFile);

export interface SpawnAppServerOptions {
  /** Override the codex binary path. Defaults to `'codex'` from PATH. */
  codexBin?: string;
  /** Working directory for the child process. */
  cwd?: string;
  /** Extra environment variables. Merged into `process.env`. */
  env?: Record<string, string | undefined>;
  /** Extra CLI args appended after `app-server`. Stdio is the default
   * `--listen`; tests pass nothing here. */
  extraArgs?: string[];
  /** Logger for stderr and lifecycle warnings. */
  log?: { warn: (msg: string) => void; info?: (msg: string) => void };
}

export interface AppServerHandle {
  /** The JSON-RPC client speaking to the child. Use this for
   * `initialize`, `thread/start`, etc. The handshake has been
   * completed before this resolves — the `initialized` notification has
   * already been sent. */
  rpc: CodexRpcClient;
  /** Echoed back from the server. Useful for logging and platform-aware
   * branches in higher layers. */
  initializeResponse: InitializeResponse;
  /** The codex CLI version reported by `codex --version` at spawn time. */
  cliVersion: string;
  /** Underlying child process. Don't kill it directly — use
   * `handle.shutdown()` so the RPC client tears down cleanly. */
  child: ChildProcess;
  /** Graceful shutdown: closes the RPC transport, sends EOF to the child,
   * waits up to `gracefulMs` for exit, then SIGKILLs as a fallback.
   * Idempotent. */
  shutdown(gracefulMs?: number): Promise<void>;
}

export interface AppServerInitOptions {
  clientInfo: ClientInfo;
  capabilities?: InitializeCapabilities | null;
}

/**
 * Detect the installed codex CLI version. Throws if `codex` isn't on
 * PATH (or at the supplied path).
 */
export async function detectCodexVersion(codexBin = 'codex'): Promise<string> {
  const { stdout } = await execFileAsync(codexBin, ['--version']);
  // Output looks like `codex-cli 0.125.0` (or just `0.125.0` on some
  // builds). Take the last whitespace-separated token.
  const last = stdout.trim().split(/\s+/).pop() ?? '';
  if (!last) throw new Error(`unexpected codex --version output: ${JSON.stringify(stdout)}`);
  return last;
}

/**
 * Compare the running codex CLI version against the schema pin and warn
 * if they disagree on minor or major. Patch-level diffs are silent.
 */
export function checkSchemaVersionCompatibility(
  cliVersion: string,
  log: { warn: (msg: string) => void },
  pinned: string = CODEX_SCHEMA_PINNED_VERSION,
): void {
  const cli = parseSemver(cliVersion);
  const pin = parseSemver(pinned);
  if (!cli || !pin) {
    log.warn(`codex schema check: unparseable version (cli=${cliVersion}, pin=${pinned})`);
    return;
  }
  if (cli.major !== pin.major || cli.minor !== pin.minor) {
    log.warn(
      `codex CLI ${cliVersion} differs from schema pin ${pinned} on minor/major. ` +
        `Run pnpm regen-codex-schema to refresh, then bump CODEX_SCHEMA_PINNED_VERSION.`,
    );
  }
}

function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Spawn `codex app-server` (stdio transport), perform the JSON-RPC
 * `initialize` handshake plus the `initialized` notification, and
 * return a connected `AppServerHandle`.
 *
 * On any failure during spawn / handshake, the child is killed before
 * the promise rejects.
 */
export async function spawnAppServer(
  init: AppServerInitOptions,
  opts: SpawnAppServerOptions = {},
): Promise<AppServerHandle> {
  const log = opts.log ?? { warn: () => {} };
  const codexBin = opts.codexBin ?? 'codex';
  const args = ['app-server', ...(opts.extraArgs ?? [])];

  let cliVersion = '';
  try {
    cliVersion = await detectCodexVersion(codexBin);
    checkSchemaVersionCompatibility(cliVersion, log);
  } catch (err) {
    throw new Error(
      `cannot detect codex CLI version (${codexBin}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...filterUndefined(opts.env) } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  const child = spawn(codexBin, args, spawnOpts);

  // Pipe stderr as warn lines so users can see what the server is up to.
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trimEnd();
    if (text) log.warn(`codex app-server [stderr] ${text}`);
  });

  let transport: StdioTransport;
  try {
    transport = new StdioTransport(child, { log });
  } catch (err) {
    safeKill(child);
    throw err;
  }

  const rpc = new CodexRpcClient(transport);

  let initializeResponse: InitializeResponse;
  try {
    initializeResponse = await rpc.request<InitializeResponse>('initialize', {
      clientInfo: init.clientInfo,
      capabilities: init.capabilities ?? null,
    });
    await rpc.notify('initialized');
  } catch (err) {
    await rpc.close().catch(() => {});
    safeKill(child);
    throw err;
  }

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (gracefulMs = 5000): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      try {
        await rpc.close();
      } catch {
        // best-effort
      }
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = waitForExit(child, gracefulMs);
      try {
        child.stdin?.end();
      } catch {
        // best-effort
      }
      const result = await exited;
      if (!result) {
        log.warn(`codex app-server did not exit within ${gracefulMs}ms; sending SIGKILL`);
        safeKill(child, 'SIGKILL');
      }
    })();
    return shutdownPromise;
  };

  return {
    rpc,
    initializeResponse,
    cliVersion,
    child,
    shutdown,
  };
}

function safeKill(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  } catch {
    // best-effort
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function filterUndefined(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
