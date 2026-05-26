// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { Attachment } from '@sumicom/quicksave-shared';

import { attachmentsToCodexUserInput } from '../provider.js';

function textAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'txt-1',
    kind: 'text',
    mimeType: 'text/markdown',
    name: 'notes.md',
    size: 11,
    data: Buffer.from('hello world', 'utf8').toString('base64'),
    ...overrides,
  };
}

function imageAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'img-1',
    kind: 'image',
    mimeType: 'image/png',
    name: 'screen.png',
    size: 4,
    data: 'aW1n',
    ...overrides,
  };
}

describe('attachmentsToCodexUserInput', () => {
  it('returns a plain text user input when there are no attachments', () => {
    expect(attachmentsToCodexUserInput('hello')).toEqual([
      { type: 'text', text: 'hello', text_elements: [] },
    ]);
  });

  it('converts text attachments before the prompt', () => {
    expect(attachmentsToCodexUserInput('summarize', [textAttachment()])).toEqual([
      {
        type: 'text',
        text: '<<<file:notes.md>>>\nhello world\n<<<end:notes.md>>>',
        text_elements: [],
      },
      { type: 'text', text: 'summarize', text_elements: [] },
    ]);
  });

  it('converts image attachments to data URLs', () => {
    expect(attachmentsToCodexUserInput('describe', [imageAttachment()])).toEqual([
      { type: 'image', url: 'data:image/png;base64,aW1n' },
      { type: 'text', text: 'describe', text_elements: [] },
    ]);
  });

  it('drops unsupported attachment kinds defensively', () => {
    expect(attachmentsToCodexUserInput('read', [
      textAttachment({ kind: 'pdf', mimeType: 'application/pdf', name: 'paper.pdf' }),
    ])).toEqual([
      { type: 'text', text: 'read', text_elements: [] },
    ]);
  });
});
