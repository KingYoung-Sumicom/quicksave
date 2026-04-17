import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (before importing module under test) ──
vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('./claudeCliProvider.js', () => ({
  getClaudeBin: vi.fn(() => '/mock/bin/claude'),
}));

const { spawn } = await import('child_process');
const { CommitSummaryCliService, CommitSummaryCliError } = await import('./commitSummaryCli.js');

// ── Fake ChildProcess helper ──

interface FakeChildOpts {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errorOnSpawn?: NodeJS.ErrnoException;
  delayMs?: number;
}

function makeFakeChild(opts: FakeChildOpts = {}) {
  const emitter = new EventEmitter() as any;
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  emitter.kill = vi.fn();
  emitter.killed = false;

  if (opts.errorOnSpawn) {
    setImmediate(() => emitter.emit('error', opts.errorOnSpawn));
    return emitter;
  }

  const fire = () => {
    if (opts.stdout) emitter.stdout.emit('data', Buffer.from(opts.stdout, 'utf8'));
    if (opts.stderr) emitter.stderr.emit('data', Buffer.from(opts.stderr, 'utf8'));
    emitter.emit('close', opts.exitCode ?? 0);
  };

  if (opts.delayMs !== undefined) {
    // Never fire close — used for timeout test.
  } else {
    setImmediate(fire);
  }

  return emitter;
}

function makeEnvelope(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '{"summary":"feat: add foo","description":"bar"}',
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  });
}

// ── Tests ──

describe('CommitSummaryCliService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateSummary — happy paths', () => {
    it('parses bare JSON result', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: makeEnvelope() }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r', attribution: false });
      expect(out.summary).toBe('feat: add foo');
      expect(out.description).toBe('bar');
    });

    it('parses result wrapped in markdown fences', async () => {
      const fenced = '```json\n{"summary":"fix: y","description":"z"}\n```';
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: makeEnvelope({ result: fenced }),
      }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r', attribution: false });
      expect(out.summary).toBe('fix: y');
    });

    it('extracts trailing JSON when prefixed with chatter', async () => {
      const mixed = 'Here you go:\n\n{"summary":"chore: tidy"}';
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: makeEnvelope({ result: mixed }),
      }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r', attribution: false });
      expect(out.summary).toBe('chore: tidy');
      expect(out.description).toBeUndefined();
    });

    it('returns token usage from envelope', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: makeEnvelope() }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r', attribution: false });
      expect(out.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50 });
    });

    it('appends attribution trailer by default', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: makeEnvelope() }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r' });
      expect(out.description).toContain('bar');
      expect(out.description).toContain('Commit-message-by: Quicksave AI');
    });

    it('attribution-only when description absent', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: makeEnvelope({ result: '{"summary":"test: only"}' }),
      }));
      const svc = new CommitSummaryCliService();
      const out = await svc.generateSummary({ repoPath: '/r' });
      expect(out.description).toBe('Commit-message-by: Quicksave AI <save@quicksave.dev>');
    });
  });

  describe('generateSummary — spawn args', () => {
    it('passes allowedTools whitelist and read-only git tools', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: makeEnvelope() }));
      const svc = new CommitSummaryCliService();
      await svc.generateSummary({ repoPath: '/some/repo', attribution: false });

      const [bin, args, spawnOpts] = (spawn as any).mock.calls[0];
      expect(bin).toBe('/mock/bin/claude');
      expect(spawnOpts.cwd).toBe('/some/repo');

      // Scan args for flags
      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('json');
      expect(args).toContain('--no-session-persistence');

      const toolsIdx = args.indexOf('--allowedTools');
      expect(toolsIdx).toBeGreaterThan(-1);
      const tools = args[toolsIdx + 1];
      expect(tools).toContain('Read');
      expect(tools).toContain('Grep');
      expect(tools).toContain('Glob');
      expect(tools).toContain('Bash(git diff:*)');
      expect(tools).toContain('Bash(git log:*)');
      // Must NOT allow writes
      expect(tools).not.toContain('Edit');
      expect(tools).not.toContain('Write');
    });

    it('passes --model when specified', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: makeEnvelope() }));
      const svc = new CommitSummaryCliService();
      await svc.generateSummary({
        repoPath: '/r',
        model: 'claude-opus-4-7',
        attribution: false,
      });
      const [, args] = (spawn as any).mock.calls[0];
      const idx = args.indexOf('--model');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('claude-opus-4-7');
    });

    it('includes branch, context, and conventions in prompt', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: makeEnvelope() }));
      const svc = new CommitSummaryCliService();
      await svc.generateSummary({
        repoPath: '/r',
        branchName: 'feature/x',
        context: 'fixing layout bug',
        conventions: 'use lowercase',
        recentCommits: ['feat: a', 'fix: b'],
        attribution: false,
      });
      const [, args] = (spawn as any).mock.calls[0];
      const promptIdx = args.indexOf('-p');
      const prompt = args[promptIdx + 1];
      expect(prompt).toContain('feature/x');
      expect(prompt).toContain('fixing layout bug');
      expect(prompt).toContain('use lowercase');
      expect(prompt).toContain('feat: a');
      expect(prompt).toContain('fix: b');
    });
  });

  describe('generateSummary — error mapping', () => {
    it('maps ENOENT to NO_CLI_BINARY', async () => {
      const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      (spawn as any).mockReturnValue(makeFakeChild({ errorOnSpawn: err as any }));
      const svc = new CommitSummaryCliService();
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'NO_CLI_BINARY' });
    });

    it('maps non-zero exit with auth hint to NO_CLI_AUTH', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({
        exitCode: 1,
        stderr: 'Not authenticated. Please log in.',
      }));
      const svc = new CommitSummaryCliService();
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'NO_CLI_AUTH' });
    });

    it('maps non-zero exit with generic error to CLI_ERROR', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({
        exitCode: 2,
        stderr: 'something went sideways',
      }));
      const svc = new CommitSummaryCliService();
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'CLI_ERROR' });
    });

    it('maps unparseable stdout to CLI_PARSE_ERROR', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({ stdout: 'not json' }));
      const svc = new CommitSummaryCliService();
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'CLI_PARSE_ERROR' });
    });

    it('maps envelope with is_error=true to CLI_ERROR', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: JSON.stringify({ is_error: true, result: 'model blew up' }),
      }));
      const svc = new CommitSummaryCliService();
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'CLI_ERROR' });
    });

    it('maps result missing summary field to CLI_PARSE_ERROR', async () => {
      (spawn as any).mockReturnValue(makeFakeChild({
        stdout: makeEnvelope({ result: 'no json here at all' }),
      }));
      const svc = new CommitSummaryCliService();
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'CLI_PARSE_ERROR' });
    });

    it('kills process and rejects with CLI_TIMEOUT when process hangs', async () => {
      const child = makeFakeChild({ delayMs: 999_999 });
      (spawn as any).mockReturnValue(child);
      const svc = new CommitSummaryCliService(50);
      await expect(svc.generateSummary({ repoPath: '/r' }))
        .rejects.toMatchObject({ errorCode: 'CLI_TIMEOUT' });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('CommitSummaryCliError', () => {
    it('preserves errorCode property', () => {
      const e = new CommitSummaryCliError('oops', 'CLI_TIMEOUT');
      expect(e.errorCode).toBe('CLI_TIMEOUT');
      expect(e.message).toBe('oops');
      expect(e.name).toBe('CommitSummaryCliError');
    });
  });
});
