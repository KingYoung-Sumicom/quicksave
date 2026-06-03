// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
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
let _codexBin: string | undefined;

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

export function _resetCodexBinCache(): void {
  _codexBin = undefined;
}

/**
 * Resolve the Codex CLI path once. Background daemons, especially systemd
 * user units, often start with a smaller PATH than the user's shell.
 */
export function getCodexBin(): string {
  if (_codexBin) return _codexBin;

  const explicit = process.env.QUICKSAVE_CODEX_BIN?.trim();
  if (explicit) {
    _codexBin = explicit;
    return _codexBin;
  }

  const fromPath = resolveFromPath('codex', process.env);
  if (fromPath) {
    _codexBin = fromPath;
    return _codexBin;
  }

  for (const candidate of commonCodexCandidates()) {
    if (isExecutable(candidate)) {
      _codexBin = candidate;
      return _codexBin;
    }
  }

  _codexBin = 'codex';
  return _codexBin;
}

/**
 * Build the environment used for Codex CLI child processes. When Codex is
 * installed under nvm/npm, the shim may rely on `env node`; prepend both the
 * resolved Codex bin directory and this daemon's Node directory.
 */
export function buildCodexCliEnv(
  env: Record<string, string | undefined> = process.env,
  codexBin = getCodexBin(),
): Record<string, string> {
  const out = filterUndefined(env);
  const pathKey = findPathKey(out);
  const prepend: string[] = [];
  if (isAbsolute(codexBin)) prepend.push(dirname(codexBin));
  if (isAbsolute(process.execPath)) prepend.push(dirname(process.execPath));
  out[pathKey] = mergePath(prepend, out[pathKey]);
  return out;
}

/**
 * Detect the installed codex CLI version. Throws if the resolved CLI cannot
 * be executed.
 */
export async function detectCodexVersion(
  codexBin = getCodexBin(),
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const { stdout } = await execFileAsync(codexBin, ['--version'], {
    encoding: 'utf8',
    env: buildCodexCliEnv(env, codexBin),
  });
  // Output looks like `codex-cli 0.125.0` (or just `0.125.0` on some
  // builds). Take the last whitespace-separated token.
  const text = stdout.toString();
  const last = text.trim().split(/\s+/).pop() ?? '';
  if (!last) throw new Error(`unexpected codex --version output: ${JSON.stringify(text)}`);
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
  const codexBin = opts.codexBin ?? getCodexBin();
  const args = ['app-server', ...(opts.extraArgs ?? [])];
  const env = buildCodexCliEnv(
    opts.env ? { ...process.env, ...filterUndefined(opts.env) } : process.env,
    codexBin,
  );

  let cliVersion = '';
  try {
    cliVersion = await detectCodexVersion(codexBin, env);
    checkSchemaVersionCompatibility(cliVersion, log);
  } catch (err) {
    throw new Error(
      `cannot detect codex CLI version (${codexBin}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env,
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

function commonCodexCandidates(): string[] {
  const home = process.env.HOME;
  if (!home) return ['/usr/local/bin/codex', '/opt/homebrew/bin/codex'];

  const candidates = [
    join(home, '.npm-global', 'bin', 'codex'),
    join(home, '.local', 'bin', 'codex'),
    join(home, '.volta', 'bin', 'codex'),
    join(home, '.bun', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ];

  appendVersionedNodeBins(candidates, join(home, '.nvm', 'versions', 'node'), (root, ver) =>
    join(root, ver, 'bin', 'codex'));
  appendVersionedNodeBins(candidates, join(home, '.local', 'share', 'fnm', 'node-versions'), (root, ver) =>
    join(root, ver, 'installation', 'bin', 'codex'));

  return candidates;
}

function appendVersionedNodeBins(
  candidates: string[],
  root: string,
  makePath: (root: string, version: string) => string,
): void {
  try {
    for (const version of readdirSync(root)) {
      candidates.push(makePath(root, version));
    }
  } catch {
    // Missing version manager directory.
  }
}

function resolveFromPath(command: string, env: Record<string, string | undefined>): string | undefined {
  const pathValue = env[findPathKey(env)];
  if (!pathValue) return undefined;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findPathKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

function mergePath(prepend: string[], existing: string | undefined): string {
  const seen = new Set<string>();
  const parts = [...prepend, ...(existing ? existing.split(delimiter) : [])]
    .filter((part) => part.length > 0)
    .filter((part) => {
      if (seen.has(part)) return false;
      seen.add(part);
      return true;
    });
  return parts.join(delimiter);
}
