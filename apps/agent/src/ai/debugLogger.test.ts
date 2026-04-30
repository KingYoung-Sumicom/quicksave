// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Redirect DEBUG_DIR to a temp directory for testing
const testDir = join(tmpdir(), `quicksave-debug-test-${Date.now()}`);

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => join(testDir, 'home') };
});

// Force enable debug mode
vi.stubEnv('QUICKSAVE_DEBUG', '1');

const { DebugLogger } = await import('./debugLogger.js');

const debugDir = join(testDir, 'home', '.quicksave', 'debug');

afterAll(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

describe('DebugLogger', () => {
  it('creates debug directory and writes raw event JSONL', async () => {
    const logger = new DebugLogger('abc123def456');
    await logger.logRawEvent({ type: 'assistant', message: { content: 'hello' } });

    const filePath = join(debugDir, 'abc123def456-raw.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe('assistant');
  });

  it('writes card events to separate JSONL', async () => {
    const logger = new DebugLogger('abc123def456');
    await logger.logCardEvent({ type: 'add', cardId: 'c1', card: { text: 'hi' } });
    await logger.logCardEvent({ type: 'update', cardId: 'c1', patch: { streaming: false } });

    const filePath = join(debugDir, 'abc123def456-cards.jsonl');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe('add');
    expect(JSON.parse(lines[1]).type).toBe('update');
  });

  it('writes card builder snapshots with timestamp', async () => {
    const logger = new DebugLogger('abc123def456');
    const cards = [
      { type: 'assistant_text', id: 'c1', text: 'hello' },
      { type: 'tool_call', id: 'c2', toolName: 'Read' },
    ];
    await logger.logCardBuilderSnapshot(cards);

    const filePath = join(debugDir, 'abc123def456-snapshots.jsonl');
    const content = readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.timestamp).toBeGreaterThan(0);
    expect(parsed.cards).toHaveLength(2);
    expect(parsed.cards[0].type).toBe('assistant_text');
  });

  it('truncates session ID to 12 chars for filenames', async () => {
    const logger = new DebugLogger('abcdef123456789long');
    await logger.logRawEvent({ type: 'test' });

    const filePath = join(debugDir, 'abcdef123456-raw.jsonl');
    expect(existsSync(filePath)).toBe(true);
  });

  it('updateSessionId changes the target file', async () => {
    const logger = new DebugLogger('session_aaaa');
    await logger.logRawEvent({ first: true });

    logger.updateSessionId('session_bbbb');
    await logger.logRawEvent({ second: true });

    expect(existsSync(join(debugDir, 'session_aaaa-raw.jsonl'))).toBe(true);
    expect(existsSync(join(debugDir, 'session_bbbb-raw.jsonl'))).toBe(true);
  });
});

describe('DebugLogger disabled', () => {
  it('does not write when QUICKSAVE_DEBUG is not 1', async () => {
    // Re-import with debug disabled
    vi.stubEnv('QUICKSAVE_DEBUG', '0');

    // Need a fresh module to pick up the new env
    vi.resetModules();
    vi.mock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => join(testDir, 'home') };
    });

    const { DebugLogger: DisabledLogger } = await import('./debugLogger.js');
    const logger = new DisabledLogger('disabled_test');
    await logger.logRawEvent({ should: 'not appear' });

    expect(existsSync(join(debugDir, 'disabled_test-raw.jsonl'))).toBe(false);
  });
});
