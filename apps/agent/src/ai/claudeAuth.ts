// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { execFile } from 'child_process';
import type { ClaudeAuthState } from '@sumicom/quicksave-shared';
import { getClaudeBin } from './claudeCliProvider.js';

const AUTH_STATUS_TIMEOUT_MS = 5_000;

type StatusRunner = (bin: string) => Promise<string>;

/** Reads Claude authentication without exposing email, org id, or org name. */
export class ClaudeAuthManager {
  constructor(private readonly runStatus: StatusRunner = runClaudeAuthStatus) {}

  async getStatus(): Promise<ClaudeAuthState> {
    if (process.env.ANTHROPIC_API_KEY) {
      return { loggedIn: true, method: 'api-key' };
    }

    try {
      return parseClaudeAuthStatus(await this.runStatus(getClaudeBin()));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return {
        loggedIn: false,
        error: code === 'ENOENT' ? 'claude-cli-not-found' : 'auth-status-unavailable',
      };
    }
  }
}

export function parseClaudeAuthStatus(raw: string): ClaudeAuthState {
  const parsed = JSON.parse(raw) as {
    loggedIn?: unknown;
    authMethod?: unknown;
    subscriptionType?: unknown;
  };
  if (typeof parsed.loggedIn !== 'boolean') {
    throw new Error('Claude auth status did not include loggedIn');
  }
  return {
    loggedIn: parsed.loggedIn,
    ...(typeof parsed.authMethod === 'string' && parsed.authMethod.length <= 64
      ? { method: parsed.authMethod }
      : {}),
    ...(typeof parsed.subscriptionType === 'string' && parsed.subscriptionType.length <= 64
      ? { subscriptionType: parsed.subscriptionType }
      : {}),
  };
}

function runClaudeAuthStatus(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['auth', 'status', '--json'],
      { timeout: AUTH_STATUS_TIMEOUT_MS, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        // Claude may use a non-zero exit code for a valid signed-out JSON
        // response. Prefer parseable stdout over the process exit status.
        if (stdout.trim()) resolve(stdout);
        else if (error) reject(error);
        else reject(new Error('Claude auth status returned no output'));
      },
    );
  });
}
