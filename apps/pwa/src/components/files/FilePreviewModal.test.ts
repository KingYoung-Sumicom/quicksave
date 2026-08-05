// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { buildLineNumberText, createPreviewDownload } from './FilePreviewModal';

describe('buildLineNumberText', () => {
  it('numbers every visible text line', () => {
    expect(buildLineNumberText('alpha\nbeta\ngamma')).toBe('1\n2\n3');
  });

  it('includes the empty final line after a trailing newline', () => {
    expect(buildLineNumberText('alpha\n')).toBe('1\n2');
  });
});

describe('createPreviewDownload', () => {
  it('creates a UTF-8 text download for previewed files', async () => {
    const download = createPreviewDownload({
      success: true,
      kind: 'text',
      content: 'hello',
    }, 'notes.md');

    expect(download?.fileName).toBe('notes.md');
    expect(download?.blob.type).toBe('text/markdown;charset=utf-8');
    expect(await download?.blob.text()).toBe('hello');
  });

  it('does not offer a download when the preview has no file body', () => {
    expect(createPreviewDownload({ success: true, kind: 'binary' }, 'archive.bin')).toBeNull();
  });
});
