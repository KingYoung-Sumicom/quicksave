import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ClaudeHistoryMessage } from '@sumicom/quicksave-shared';

// Mock getSessionsDir to use a temp directory
let tempDir: string;

vi.mock('../service/singleton.js', () => ({
  getSessionsDir: () => tempDir,
}));

// Import after mock is set up
const { appendMessageToJSONL, loadMessagesFromJSONL, getSessionDir, getMessagesFilePath } =
  await import('./sessionStore.js');

describe('sessionStore', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sessionStore-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const makeMsg = (
    index: number,
    role: 'user' | 'assistant' = 'user',
    content = `message ${index}`
  ): ClaudeHistoryMessage => ({ index, role, content });

  describe('getSessionDir', () => {
    it('creates the session directory if it does not exist', () => {
      const dir = getSessionDir('test-session-1');
      expect(dir).toBe(join(tempDir, 'test-session-1'));
      // Verify it exists by writing a file into it (no throw = exists)
      const { writeFileSync } = require('fs');
      writeFileSync(join(dir, 'probe'), 'ok');
    });
  });

  describe('getMessagesFilePath', () => {
    it('returns path ending in messages.jsonl', () => {
      const path = getMessagesFilePath('sess-abc');
      expect(path).toBe(join(tempDir, 'sess-abc', 'messages.jsonl'));
    });
  });

  describe('appendMessageToJSONL + loadMessagesFromJSONL', () => {
    it('round-trips messages correctly', () => {
      const sessionId = 'round-trip-test';
      appendMessageToJSONL(sessionId, makeMsg(0, 'user', 'hello'));
      appendMessageToJSONL(sessionId, makeMsg(1, 'assistant', 'hi there'));
      appendMessageToJSONL(sessionId, makeMsg(2, 'user', 'run ls'));

      const loaded = loadMessagesFromJSONL(sessionId);
      expect(loaded).toHaveLength(3);
      expect(loaded[0]).toEqual({ index: 0, role: 'user', content: 'hello' });
      expect(loaded[1]).toEqual({ index: 1, role: 'assistant', content: 'hi there' });
      expect(loaded[2]).toEqual({ index: 2, role: 'user', content: 'run ls' });
    });

    it('preserves optional fields (toolName, toolInput, toolResult, truncated)', () => {
      const sessionId = 'fields-test';
      const msg: ClaudeHistoryMessage = {
        index: 0,
        role: 'assistant',
        content: '',
        toolName: 'Bash',
        toolInput: '{"command":"ls"}',
        toolResult: 'file1\nfile2',
        truncated: false,
      };
      appendMessageToJSONL(sessionId, msg);

      const loaded = loadMessagesFromJSONL(sessionId);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(msg);
    });

    it('produces valid JSONL (one JSON object per line)', () => {
      const sessionId = 'jsonl-format-test';
      appendMessageToJSONL(sessionId, makeMsg(0));
      appendMessageToJSONL(sessionId, makeMsg(1));

      const raw = readFileSync(getMessagesFilePath(sessionId), 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim() !== '');
      expect(lines).toHaveLength(2);
      // Each line should parse independently
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  describe('loadMessagesFromJSONL', () => {
    it('returns empty array for non-existent session', () => {
      const loaded = loadMessagesFromJSONL('does-not-exist');
      expect(loaded).toEqual([]);
    });

    it('skips malformed lines gracefully', () => {
      const sessionId = 'malformed-test';
      const { writeFileSync, mkdirSync } = require('fs');
      const dir = join(tempDir, sessionId);
      mkdirSync(dir, { recursive: true });

      const content = [
        JSON.stringify(makeMsg(0, 'user', 'good line')),
        'this is not json{{{',
        JSON.stringify(makeMsg(2, 'assistant', 'also good')),
      ].join('\n') + '\n';

      writeFileSync(join(dir, 'messages.jsonl'), content);

      const loaded = loadMessagesFromJSONL(sessionId);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].content).toBe('good line');
      expect(loaded[1].content).toBe('also good');
    });
  });
});
