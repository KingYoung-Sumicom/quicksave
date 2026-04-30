// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { ClaudeCliProvider } from './claudeCliProvider.js';
import { ClaudeSdkProvider } from './claudeSdkProvider.js';
import type {
  CodingAgentProvider,
  ProviderCallbacks,
  ProviderSession,
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
}
