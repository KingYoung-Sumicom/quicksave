// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  buildLineNumberText,
  buildSafeHtmlPreviewDocument,
  createPreviewDownload,
} from './FilePreviewModal';

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

  it('creates an octet-stream download for binary bytes received over WebRTC', async () => {
    const download = createPreviewDownload({
      success: true,
      kind: 'binary',
      content: 'AAEC/w==',
      encoding: 'base64',
    }, 'archive.bin');

    expect(download?.fileName).toBe('archive.bin');
    expect(download?.blob.type).toBe('application/octet-stream');
    expect(new Uint8Array(await download?.blob.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
  });
});

describe('buildSafeHtmlPreviewDocument', () => {
  it('injects a restrictive content security policy into an existing head', () => {
    const preview = buildSafeHtmlPreviewDocument('<html><head><title>Demo</title></head><body>Hello</body></html>');

    expect(preview).toContain('<head><meta http-equiv="Content-Security-Policy"');
    expect(preview).toContain("default-src 'none'");
    expect(preview).toContain('<title>Demo</title>');
  });

  it('creates a head when the document does not include one', () => {
    const preview = buildSafeHtmlPreviewDocument('<html><body>Hello</body></html>');

    expect(preview).toContain('<html><head><meta http-equiv="Content-Security-Policy"');
  });
});
