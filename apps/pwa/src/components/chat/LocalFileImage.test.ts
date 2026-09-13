// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { isDirectImageSource, isLocalFileUrl, localImagePath } from './LocalFileImage';

describe('localImagePath', () => {
  it('decodes local paths and removes browser-only suffixes', () => {
    expect(localImagePath('/tmp/render%20output.png?raw=1#preview')).toBe('/tmp/render output.png');
    expect(localImagePath('./screenshots/result.png#large')).toBe('./screenshots/result.png');
  });

  it('converts local file URLs to filesystem paths', () => {
    expect(localImagePath('file:///tmp/render%20output.png')).toBe('/tmp/render output.png');
    expect(localImagePath('file://localhost/tmp/cat.png')).toBe('/tmp/cat.png');
  });
});

describe('isDirectImageSource', () => {
  it('only lets browser-readable image sources bypass files:read', () => {
    expect(isDirectImageSource('https://example.com/image.png')).toBe(true);
    expect(isDirectImageSource('data:image/png;base64,AAAA')).toBe(true);
    expect(isDirectImageSource('blob:https://example.com/id')).toBe(true);
    expect(isDirectImageSource('file:///tmp/image.png')).toBe(false);
    expect(isDirectImageSource('/tmp/image.png')).toBe(false);
  });
});

describe('isLocalFileUrl', () => {
  it('accepts only local-host file URLs', () => {
    expect(isLocalFileUrl('file:///tmp/image.png')).toBe(true);
    expect(isLocalFileUrl('file://localhost/tmp/image.png')).toBe(true);
    expect(isLocalFileUrl('file://remote-host/tmp/image.png')).toBe(false);
  });
});
