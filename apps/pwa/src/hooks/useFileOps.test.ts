// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { shouldUseFileRtc } from './useFileOps';

describe('shouldUseFileRtc', () => {
  it('uses the direct channel for binary files that cannot be previewed', () => {
    expect(shouldUseFileRtc({ success: true, kind: 'binary', size: 42 })).toBe(true);
  });

  it('continues using the direct channel for oversized previews', () => {
    expect(shouldUseFileRtc({ success: true, kind: 'oversized', size: 5_000_000 })).toBe(true);
  });

  it('keeps supported inline bodies on the message bus', () => {
    expect(shouldUseFileRtc({ success: true, kind: 'text', content: 'hello' })).toBe(false);
    expect(shouldUseFileRtc({ success: true, kind: 'image', content: 'AA==' })).toBe(false);
  });
});
