// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * JSONL persistence for Claude session message history.
 *
 * Each session gets a file at:
 *   ~/.quicksave/state/sessions/<session-id>/messages.jsonl
 *
 * One JSON object per line, matching ClaudeHistoryMessage shape.
 * Append-only writes; full-file reads on cold resume.
 */

import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getSessionsDir } from '../service/singleton.js';
import type { ClaudeHistoryMessage } from '@sumicom/quicksave-shared';

/**
 * Return the directory for a specific session's persistent data.
 * Creates the directory if it doesn't exist.
 */
export function getSessionDir(sessionId: string): string {
  const dir = join(getSessionsDir(), sessionId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Return the path to a session's messages JSONL file.
 */
export function getMessagesFilePath(sessionId: string): string {
  return join(getSessionDir(sessionId), 'messages.jsonl');
}

/**
 * Append a single message to the session's JSONL file.
 * Errors are logged, not thrown.
 */
export function appendMessageToJSONL(
  sessionId: string,
  message: ClaudeHistoryMessage
): void {
  try {
    const filePath = getMessagesFilePath(sessionId);
    const line = JSON.stringify(message) + '\n';
    appendFileSync(filePath, line, 'utf-8');
  } catch (err) {
    console.error(
      `[sessionStore] Failed to append message to JSONL for session=${sessionId}:`,
      err
    );
  }
}

/**
 * Load all messages from a session's JSONL file.
 * Returns empty array if file doesn't exist or is unreadable.
 * Skips malformed lines with a warning.
 */
export function loadMessagesFromJSONL(
  sessionId: string
): ClaudeHistoryMessage[] {
  try {
    const filePath = join(getSessionsDir(), sessionId, 'messages.jsonl');
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim() !== '');
    const messages: ClaudeHistoryMessage[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        messages.push(JSON.parse(lines[i]) as ClaudeHistoryMessage);
      } catch {
        console.warn(
          `[sessionStore] Skipping malformed JSONL line ${i + 1} for session=${sessionId}`
        );
      }
    }

    return messages;
  } catch (err) {
    console.error(
      `[sessionStore] Failed to load messages from JSONL for session=${sessionId}:`,
      err
    );
    return [];
  }
}
