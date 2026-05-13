// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { ClaudeCliProvider } from './claudeCliProvider.js';
import { ClaudeSdkProvider } from './claudeSdkProvider.js';
import type {
  CodingAgentProvider,
  ProviderCallbacks,
  ProviderSession,
  ProbeResult,
  ResumeSessionOpts,
  StartSessionOpts,
} from './provider.js';
import type { StreamCardBuilder } from './cardBuilder.js';

type ClaudeTransport = 'cli' | 'sdk';

function resolveClaudeTransport(): ClaudeTransport {
  const explicit = process.env.QUICKSAVE_CLAUDE_TRANSPORT;
  if (explicit === 'sdk' || explicit === 'cli') {
    return explicit;
  }

  if (process.env.QUICKSAVE_PROVIDER === 'sdk') {
    return 'sdk';
  }

  return 'cli';
}

export class ClaudeCodeProvider implements CodingAgentProvider {
  readonly id = 'claude-code' as const;
  readonly historyMode = 'claude-jsonl' as const;
  readonly label = 'Claude Code';

  private readonly cliProvider = new ClaudeCliProvider();
  private readonly sdkProvider = new ClaudeSdkProvider();

  private getTransport(): CodingAgentProvider {
    return resolveClaudeTransport() === 'sdk'
      ? this.sdkProvider
      : this.cliProvider;
  }

  async startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    return this.getTransport().startSession(opts, cardBuilder, callbacks);
  }

  async resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }> {
    return this.getTransport().resumeSession(opts, cardBuilder, callbacks);
  }

  async probeProvider(): Promise<any> {
    const hasCli = this.isCliAvailable();
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    const transport = resolveClaudeTransport();

    const capabilities = {
      hasApiKey,
      hasCli,
      hasPlugin: false,
      supportsResume: true,
      supportsSandbox: !!process.env.QUICKSAVE_SANDBOX,
      supportsStreaming: true,
    };

    return {
      version: hasCli ? await this._getVersion(hasApiKey) : undefined,
      capabilities,
    };
  }

  private isCliAvailable(): boolean {
    try {
      const execSync = require('child_process').execSync;
      const result = execSync('which claude', { timeout: 3000, encoding: 'utf-8' }).trim();
      return !!result;
    } catch {
      return false;
    }
  }

  private async _getVersion(hasApiKey: boolean): Promise<string | undefined> {
    try {
      const execSync = require('child_process').execSync;
      const result = hasApiKey
        ? '0.0.0'
        : execSync('claude --version', { timeout: 3000, encoding: 'utf-8' }).trim();
      return result || undefined;
    } catch {
      return hasApiKey ? 'sdk' : undefined;
    }
  }
}
