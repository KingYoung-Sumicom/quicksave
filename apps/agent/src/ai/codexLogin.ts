import { spawn, type ChildProcess } from 'child_process';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { CodexLoginState } from '@sumicom/quicksave-shared';

/**
 * Coordinates `codex login --device-auth` on behalf of the PWA. The daemon
 * spawns the codex CLI, parses the one-time verification URL and user code
 * from its stdout, and exposes them to the PWA so the user can complete the
 * flow on whatever device they have at hand (typically a phone).
 *
 * Only one login attempt runs at a time. Subsequent `start()` calls while
 * inProgress return the existing state — the same URL / code the first
 * caller already has, which is what we want when the PWA reconnects
 * mid-flow and re-requests the status.
 */

/** Device codes expire after 15 minutes per the OpenAI device-auth protocol. */
const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;
/** Abandon if the CLI hasn't emitted a code within this window. Longer than
 *  device-code TTL so a slow OAuth provider still surfaces the code rather
 *  than us killing the process prematurely. */
const PARSE_TIMEOUT_MS = 30_000;

const ANSI_RE = /\x1b\[[0-9;]*m/g;
// Observed codex CLI codes are 4-5 chars per half (e.g. `YKFF-30JQC`). Allow
// a small range on each side so a protocol change doesn't silently break
// parsing, while the uppercase-only constraint keeps false positives low.
const CODE_RE = /\b([A-Z0-9]{3,6}-[A-Z0-9]{3,6})\b/;
const URL_RE = /https?:\/\/[^\s]+/;

export type CodexLoginUpdateHandler = (state: CodexLoginState) => void;

export class CodexLoginManager {
  private state: CodexLoginState = { loggedIn: false, inProgress: false };
  private child: ChildProcess | null = null;
  private parseTimer: NodeJS.Timeout | null = null;
  private stdoutBuf = '';
  private onUpdate?: CodexLoginUpdateHandler;

  setUpdateHandler(handler: CodexLoginUpdateHandler | undefined): void {
    this.onUpdate = handler;
  }

  /**
   * Returns a fresh snapshot of login status. Consults the filesystem each
   * call so a login completed out-of-band (user ran `codex login` in their
   * terminal) is detected without restarting the daemon.
   */
  async getStatus(): Promise<CodexLoginState> {
    const auth = await detectAuth();
    if (auth.loggedIn) {
      // A prior in-progress flow may have succeeded; clear the transient fields.
      this.state = {
        loggedIn: true,
        inProgress: false,
        method: auth.method,
      };
      return { ...this.state };
    }
    // Preserve the in-progress details so a reconnecting PWA sees the same code.
    return { ...this.state, loggedIn: false };
  }

  /**
   * Start a device-auth login flow. Spawns `codex login --device-auth`,
   * parses its stdout for the verification URL + user code, and returns
   * once both are available (or the CLI exits / times out).
   */
  async start(): Promise<CodexLoginState> {
    const current = await this.getStatus();
    if (current.loggedIn) return current;
    if (this.state.inProgress && this.state.userCode) {
      return { ...this.state };
    }

    // Reset and spawn.
    this.cleanup();
    this.state = { loggedIn: false, inProgress: true };
    this.emit();

    const child = spawn('codex', ['login', '--device-auth'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;
    this.stdoutBuf = '';

    // Resolves once we've parsed URL + code from stdout, or once the parse
    // timer fires, or once the process exits early.
    const parsed = new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (this.parseTimer) clearTimeout(this.parseTimer);
        this.parseTimer = null;
        resolve();
      };

      const onStdout = (chunk: Buffer) => {
        this.stdoutBuf += chunk.toString('utf-8');
        const parsedState = parseDeviceAuthOutput(this.stdoutBuf);
        if (parsedState && (this.state.verificationUrl !== parsedState.verificationUrl ||
                            this.state.userCode !== parsedState.userCode)) {
          this.state = {
            loggedIn: false,
            inProgress: true,
            verificationUrl: parsedState.verificationUrl,
            userCode: parsedState.userCode,
            expiresAt: Date.now() + DEVICE_CODE_TTL_MS,
          };
          this.emit();
          settle();
        }
      };

      child.stdout?.on('data', onStdout);
      // Codex prints the login instructions to stdout, but some distros may
      // tee to stderr — tail it too so we don't miss a working flow.
      child.stderr?.on('data', onStdout);

      child.once('exit', (code) => this.handleExit(code));
      child.once('error', (err) => this.handleError(err.message || 'spawn failed'));

      this.parseTimer = setTimeout(() => {
        if (!this.state.userCode) {
          this.handleError('Timed out waiting for device code from `codex login --device-auth`');
          child.kill('SIGTERM');
        }
        settle();
      }, PARSE_TIMEOUT_MS);
    });

    await parsed;
    return { ...this.state };
  }

  /**
   * Cancel an in-progress login. Safe to call when nothing is running —
   * returns the current state unchanged.
   */
  cancel(): CodexLoginState {
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.cleanup();
    this.state = {
      loggedIn: false,
      inProgress: false,
      error: 'cancelled',
    };
    this.emit();
    return { ...this.state };
  }

  private handleExit(code: number | null): void {
    const wasInProgress = this.state.inProgress;
    this.cleanup();

    void detectAuth().then((auth) => {
      if (auth.loggedIn) {
        this.state = { loggedIn: true, inProgress: false, method: auth.method };
      } else if (wasInProgress) {
        this.state = {
          loggedIn: false,
          inProgress: false,
          error: code === 0
            ? 'Login exited without credentials'
            : `codex login exited with code ${code ?? 'unknown'}`,
        };
      }
      this.emit();
    });
  }

  private handleError(message: string): void {
    this.cleanup();
    this.state = { loggedIn: false, inProgress: false, error: message };
    this.emit();
  }

  private cleanup(): void {
    if (this.parseTimer) {
      clearTimeout(this.parseTimer);
      this.parseTimer = null;
    }
    this.child = null;
    this.stdoutBuf = '';
  }

  private emit(): void {
    try { this.onUpdate?.({ ...this.state }); } catch { /* ignore handler errors */ }
  }

  /** Test-only: inject output as if the spawned CLI printed it. */
  _debugFeed(chunk: string): void {
    this.stdoutBuf += chunk;
    const parsedState = parseDeviceAuthOutput(this.stdoutBuf);
    if (parsedState) {
      this.state = {
        loggedIn: false,
        inProgress: true,
        verificationUrl: parsedState.verificationUrl,
        userCode: parsedState.userCode,
        expiresAt: Date.now() + DEVICE_CODE_TTL_MS,
      };
      this.emit();
    }
  }
}

/**
 * Parse `codex login --device-auth` stdout.
 *
 * Sample (ANSI escapes stripped):
 *
 *     Welcome to Codex [v0.118.0]
 *     OpenAI's command-line coding agent
 *
 *     Follow these steps to sign in with ChatGPT using device code authorization:
 *
 *     1. Open this link in your browser and sign in to your account
 *        https://auth.openai.com/codex/device
 *
 *     2. Enter this one-time code (expires in 15 minutes)
 *        YKFF-30JQC
 *
 * We look for the first bare https URL and the first XXXX-XXXX code token.
 * Returns null until both have appeared.
 */
export function parseDeviceAuthOutput(raw: string): { verificationUrl: string; userCode: string } | null {
  const plain = raw.replace(ANSI_RE, '');
  const urlMatch = plain.match(URL_RE);
  const codeMatch = plain.match(CODE_RE);
  if (!urlMatch || !codeMatch) return null;
  return { verificationUrl: urlMatch[0], userCode: codeMatch[1] };
}

async function detectAuth(): Promise<{ loggedIn: boolean; method?: 'chatgpt' | 'api-key' }> {
  if (process.env.OPENAI_API_KEY) return { loggedIn: true, method: 'api-key' };
  try {
    const authPath = join(homedir(), '.codex', 'auth.json');
    const raw = await readFile(authPath, 'utf-8');
    const auth = JSON.parse(raw) as {
      OPENAI_API_KEY?: string;
      tokens?: { access_token?: string };
    };
    if (auth.OPENAI_API_KEY) return { loggedIn: true, method: 'api-key' };
    if (auth.tokens?.access_token) return { loggedIn: true, method: 'chatgpt' };
  } catch { /* no auth file */ }
  return { loggedIn: false };
}
