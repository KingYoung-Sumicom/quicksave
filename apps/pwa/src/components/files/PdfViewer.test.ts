// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { pageSwipeDirection } from './PdfViewer';

describe('pageSwipeDirection', () => {
  it('maps a left swipe to the next page and a right swipe to the previous page', () => {
    expect(pageSwipeDirection(-120, 8)).toBe(1);
    expect(pageSwipeDirection(120, 8)).toBe(-1);
  });

  it('ignores short or mostly vertical drags', () => {
    expect(pageSwipeDirection(-40, 0)).toBe(0);
    expect(pageSwipeDirection(-120, 140)).toBe(0);
  });
});
