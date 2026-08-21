// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { StdioTransport } from '../stdioTransport.js';

describe('StdioTransport', () => {
  it('reassembles a Codex response containing a literal newline in a string', () => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
    }) as any;
    const transport = new StdioTransport(child);
    const messages: unknown[] = [];
    transport.onMessage((message) => messages.push(message));

    // Codex 0.149 can serialize a legacy thread history with a literal
    // newline inside a JSON string, despite normally using JSONL framing.
    stdout.write('{"id":2,"result":{"history":"first\n');
    stdout.write('second"}}\n');

    expect(messages).toEqual([{ id: 2, result: { history: 'first\nsecond' } }]);
  });
});
