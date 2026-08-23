// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { imagePathFromSystemText } from './SystemMessage';

describe('imagePathFromSystemText', () => {
  it('recognizes Codex image-view cards', () => {
    expect(imagePathFromSystemText('[image: /tmp/cat.png]')).toBe('/tmp/cat.png');
    expect(imagePathFromSystemText('[image: ./screenshots/result one.png]')).toBe('./screenshots/result one.png');
  });

  it('does not reinterpret ordinary system messages', () => {
    expect(imagePathFromSystemText('Viewed [image: /tmp/cat.png]')).toBeNull();
    expect(imagePathFromSystemText('[plan] (empty)')).toBeNull();
  });
});
