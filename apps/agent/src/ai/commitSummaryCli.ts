import { spawn } from 'child_process';
import type {
  ClaudeModel,
  GenerateCommitSummaryErrorCode,
  TokenUsage,
} from '@sumicom/quicksave-shared';
import { getClaudeBin } from './claudeCliProvider.js';

export interface GenerateCliSummaryOptions {
  repoPath: string;
  context?: string;
  model?: ClaudeModel;
  recentCommits?: string[];
  branchName?: string;
  conventions?: string;
  attribution?: boolean;
}

export interface GenerateCliSummaryResult {
  summary: string;
  description?: string;
  tokenUsage?: TokenUsage;
}

export class CommitSummaryCliError extends Error {
  constructor(
    message: string,
    public errorCode: GenerateCommitSummaryErrorCode
  ) {
    super(message);
    this.name = 'CommitSummaryCliError';
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git status:*)',
  'Bash(git show:*)',
  'Bash(git blame:*)',
].join(',');

export class CommitSummaryCliService {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async generateSummary(options: GenerateCliSummaryOptions): Promise<GenerateCliSummaryResult> {
    const { repoPath, model, attribution = true } = options;

    const prompt = this.buildPrompt(options);
    const bin = getClaudeBin();

    const args: string[] = [
      '-p',
      prompt,
      '--output-format', 'json',
      '--allowedTools', ALLOWED_TOOLS,
      '--no-session-persistence',
    ];
    if (model) {
      args.push('--model', model);
    }

    const raw = await this.spawnAndCollect(bin, args, repoPath);
    const parsed = this.parseCliEnvelope(raw);
    const { summary, description } = this.extractCommitMessage(parsed.result);

    const finalDescription = attribution
      ? appendAttribution(description)
      : description;

    return {
      summary,
      description: finalDescription,
      tokenUsage: parsed.tokenUsage,
    };
  }

  private spawnAndCollect(bin: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(bin, args, {
          cwd,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(mapSpawnError(err));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        reject(new CommitSummaryCliError(
          `Claude CLI timed out after ${Math.round(this.timeoutMs / 1000)}s`,
          'CLI_TIMEOUT'
        ));
      }, this.timeoutMs);

      child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(mapSpawnError(err));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const hint = stderr.trim() || stdout.trim() || `exit code ${code}`;
          reject(classifyCliFailure(hint, code));
          return;
        }
        resolve(stdout);
      });
    });
  }

  private parseCliEnvelope(raw: string): { result: string; tokenUsage?: TokenUsage } {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new CommitSummaryCliError('Claude CLI produced no output', 'CLI_PARSE_ERROR');
    }

    // --output-format json emits a single JSON object on stdout.
    let envelope: any;
    try {
      envelope = JSON.parse(trimmed);
    } catch {
      const lastLine = trimmed.split('\n').filter(Boolean).pop() ?? '';
      try {
        envelope = JSON.parse(lastLine);
      } catch {
        throw new CommitSummaryCliError(
          'Failed to parse Claude CLI output as JSON',
          'CLI_PARSE_ERROR'
        );
      }
    }

    if (envelope?.is_error) {
      const errText = typeof envelope.result === 'string' ? envelope.result : 'Claude CLI reported an error';
      throw classifyCliFailure(errText, null);
    }

    const result = typeof envelope?.result === 'string' ? envelope.result : '';
    if (!result) {
      throw new CommitSummaryCliError(
        'Claude CLI returned an empty result',
        'CLI_PARSE_ERROR'
      );
    }

    const tokenUsage = extractTokenUsage(envelope?.usage);
    return { result, tokenUsage };
  }

  private extractCommitMessage(result: string): { summary: string; description?: string } {
    const text = stripMarkdownFences(result).trim();

    // Try to parse the whole thing as JSON first.
    const direct = tryParseCommitJson(text);
    if (direct) return direct;

    // Find the last {...} block — model may prefix with chatter.
    const match = text.match(/\{[\s\S]*\}\s*$/);
    if (match) {
      const extracted = tryParseCommitJson(match[0]);
      if (extracted) return extracted;
    }

    throw new CommitSummaryCliError(
      'Could not extract {summary, description} from Claude CLI output',
      'CLI_PARSE_ERROR'
    );
  }

  private buildPrompt(opts: GenerateCliSummaryOptions): string {
    const sections: string[] = [
      'You are generating a git commit message for staged changes in this repository.',
      '',
      'Steps:',
      '1. Run `git diff --cached` to inspect staged changes.',
      '2. If staged changes touch a function, type, or component that is referenced elsewhere, briefly inspect those call sites (Grep + Read) to understand intent.',
      '3. If recent commits show a clear style, match it (`git log --oneline -20`).',
      '4. Output ONLY a JSON object on the final line:',
      '   {"summary": "<conventional-commit summary, <=72 chars>", "description": "<optional body or omit>"}',
      '',
      'Guidelines:',
      '- Conventional commits prefixes: feat:, fix:, docs:, refactor:, chore:, test:, style:, perf:, ci:, build:',
      '- Keep the summary under 72 characters',
      '- Focus on WHAT changed and WHY, not HOW',
      '- Be specific but concise',
      '- Do NOT write anything after the JSON object',
    ];

    if (opts.conventions) {
      sections.push('', 'Project commit conventions:', opts.conventions);
    }
    if (opts.recentCommits?.length) {
      sections.push('', 'Recent commits (match this style):', ...opts.recentCommits.map((m) => `- ${m}`));
    }
    if (opts.branchName) {
      sections.push('', `Branch: ${opts.branchName}`);
    }
    if (opts.context) {
      sections.push('', `User context: ${opts.context}`);
    }

    return sections.join('\n');
  }
}

function stripMarkdownFences(text: string): string {
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return fence ? fence[1] : text;
}

function tryParseCommitJson(text: string): { summary: string; description?: string } | null {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj.summary === 'string' && obj.summary.trim()) {
      const description = typeof obj.description === 'string' && obj.description.trim()
        ? obj.description.trim()
        : undefined;
      return { summary: obj.summary.trim(), description };
    }
  } catch { /* fall through */ }
  return null;
}

function appendAttribution(description: string | undefined): string {
  const trailer = 'Commit-message-by: Quicksave AI <save@quicksave.dev>';
  return description ? `${description}\n\n${trailer}` : trailer;
}

function extractTokenUsage(usage: any): TokenUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = Number(usage.input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;
  if (!inputTokens && !outputTokens) return undefined;
  return { inputTokens, outputTokens };
}

function mapSpawnError(err: unknown): CommitSummaryCliError {
  const msg = err instanceof Error ? err.message : String(err);
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return new CommitSummaryCliError(
      'Claude CLI binary not found. Install with: npm install -g @anthropic-ai/claude-code',
      'NO_CLI_BINARY'
    );
  }
  return new CommitSummaryCliError(`Failed to spawn Claude CLI: ${msg}`, 'CLI_ERROR');
}

function classifyCliFailure(hint: string, _exitCode: number | null): CommitSummaryCliError {
  const lower = hint.toLowerCase();
  if (lower.includes('not authenticated') || lower.includes('please log in') || lower.includes('login') || lower.includes('api key')) {
    return new CommitSummaryCliError(
      'Claude CLI is not authenticated. Run `claude` once to log in.',
      'NO_CLI_AUTH'
    );
  }
  return new CommitSummaryCliError(hint, 'CLI_ERROR');
}
