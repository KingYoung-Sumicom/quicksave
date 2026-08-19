// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from 'vitest';
import { clearComposerDraft, loadComposerDraft, saveComposerDraft } from './composerDraft';

describe('composerDraft', () => {
  beforeEach(() => localStorage.clear());

  it('keeps drafts isolated by their composer key and clears empty/sent text', () => {
    saveComposerDraft('qs_addnew_draft_project-a', 'first prompt');
    saveComposerDraft('qs_addnew_draft_project-b', 'second prompt');

    expect(loadComposerDraft('qs_addnew_draft_project-a')).toBe('first prompt');
    expect(loadComposerDraft('qs_addnew_draft_project-b')).toBe('second prompt');

    clearComposerDraft('qs_addnew_draft_project-a');
    saveComposerDraft('qs_addnew_draft_project-b', '');
    expect(loadComposerDraft('qs_addnew_draft_project-a')).toBe('');
    expect(loadComposerDraft('qs_addnew_draft_project-b')).toBe('');
  });
});
