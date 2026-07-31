// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { parseReadToolResult, parseShellToolResult } from './openCodeToolResult';

describe('parseReadToolResult', () => {
  it('extracts file content from the OpenCode read wrapper', () => {
    expect(parseReadToolResult([
      '<path>/repo/src/index.ts</path>',
      '<type>file</type>',
      '<content>',
      '1: export const answer = 42;',
      '',
      '(End of file - total 1 lines)',
      '</content>',
    ].join('\n'))).toEqual({
      path: '/repo/src/index.ts',
      type: 'file',
      content: '1: export const answer = 42;\n\n(End of file - total 1 lines)',
    });
  });

  it('extracts directory entries from the OpenCode read wrapper', () => {
    expect(parseReadToolResult([
      '<path>/repo/src</path>',
      '<type>directory</type>',
      '<entries>',
      'index.ts',
      'tool/',
      '',
      '(2 entries)',
      '</entries>',
    ].join('\n'))).toEqual({
      path: '/repo/src',
      type: 'directory',
      content: 'index.ts\ntool/\n\n(2 entries)',
    });
  });

  it('omits model-only system reminders after file content', () => {
    const parsed = parseReadToolResult([
      '<path>/repo/AGENTS.md</path>',
      '<type>file</type>',
      '<content>',
      '1: Instructions',
      '</content>',
      '',
      '<system-reminder>',
      'Do not show this in the card.',
      '</system-reminder>',
    ].join('\n'));

    expect(parsed?.content).toBe('1: Instructions');
  });

  it('uses the final standalone closing tag when file text contains markup', () => {
    const parsed = parseReadToolResult([
      '<path>/repo/example.txt</path>',
      '<type>file</type>',
      '<content>',
      '1: literal </content> inside a line',
      '</content>',
    ].join('\n'));

    expect(parsed?.content).toBe('1: literal </content> inside a line');
  });

  it('leaves non-OpenCode results untouched', () => {
    expect(parseReadToolResult('plain read output')).toBeNull();
  });
});

describe('parseShellToolResult', () => {
  it('removes the OpenCode shell wrapper but preserves its message', () => {
    expect(parseShellToolResult([
      'partial command output',
      '',
      '<shell_metadata>',
      'shell tool terminated command after exceeding timeout 120000 ms.',
      '</shell_metadata>',
    ].join('\n'))).toEqual({
      output: 'partial command output',
      metadata: 'shell tool terminated command after exceeding timeout 120000 ms.',
      content: [
        'partial command output',
        '',
        'shell tool terminated command after exceeding timeout 120000 ms.',
      ].join('\n'),
    });
  });

  it('leaves ordinary shell output untouched', () => {
    expect(parseShellToolResult('plain command output')).toBeNull();
  });
});
