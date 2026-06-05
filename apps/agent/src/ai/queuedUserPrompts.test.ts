// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { makeQueuedUserPrompt, queueStateFor, previewQueuedPrompt } from './queuedUserPrompts.js';

describe('makeQueuedUserPrompt', () => {
  it('assigns a fresh unique id and preserves prompt + attachments', () => {
    const a = makeQueuedUserPrompt('hello');
    const b = makeQueuedUserPrompt('hello');
    expect(a.id).toEqual(expect.any(String));
    expect(a.id).not.toBe(b.id); // ids are per-message, even for identical text
    expect(a.prompt).toBe('hello');

    const atts = [
      { id: 'att-1', kind: 'image', name: 'x.png', mimeType: 'image/png', size: 1, data: 'AA==' },
    ] as const;
    const withAtt = makeQueuedUserPrompt('see image', atts);
    expect(withAtt.attachments).toBe(atts);
  });
});

describe('queueStateFor', () => {
  it('returns null for an empty queue', () => {
    expect(queueStateFor([], true)).toBeNull();
  });

  it('emits queuedPromptIds index-aligned with queuedPromptPreviews', () => {
    const first = makeQueuedUserPrompt('first prompt');
    const second = makeQueuedUserPrompt('second prompt');

    const state = queueStateFor([first, second], true);

    expect(state).toMatchObject({
      pendingUserMessages: 2,
      latestPromptPreview: previewQueuedPrompt('second prompt'),
      queuedPromptPreviews: ['first prompt', 'second prompt'],
      queuedPromptIds: [first.id, second.id],
      canInterruptCurrentTurn: true,
    });
  });

  it('passes through canInterruptCurrentTurn=false', () => {
    const state = queueStateFor([makeQueuedUserPrompt('q')], false);
    expect(state?.canInterruptCurrentTurn).toBe(false);
  });
});
