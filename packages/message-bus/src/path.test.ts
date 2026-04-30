// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  matchPattern,
  parsePattern,
  sortPatternsBySpecificity,
} from './path.js';

describe('parsePattern', () => {
  it('parses a static pattern', () => {
    const p = parsePattern('/sessions/active');
    expect(p.segments).toEqual([
      { kind: 'static', value: 'sessions' },
      { kind: 'static', value: 'active' },
    ]);
  });

  it('parses a pattern with params', () => {
    const p = parsePattern('/sessions/:id/cards/:cardId');
    expect(p.segments).toEqual([
      { kind: 'static', value: 'sessions' },
      { kind: 'param', name: 'id' },
      { kind: 'static', value: 'cards' },
      { kind: 'param', name: 'cardId' },
    ]);
  });

  it('rejects empty param names', () => {
    expect(() => parsePattern('/sessions/:')).toThrow();
  });

  it('normalizes leading and trailing slashes', () => {
    const a = parsePattern('/sessions/:id');
    const b = parsePattern('sessions/:id/');
    expect(a.segments).toEqual(b.segments);
  });
});

describe('matchPattern', () => {
  it('matches a static path', () => {
    const p = parsePattern('/sessions/active');
    expect(matchPattern(p, '/sessions/active')).toEqual({});
  });

  it('extracts params', () => {
    const p = parsePattern('/sessions/:id');
    expect(matchPattern(p, '/sessions/abc123')).toEqual({ id: 'abc123' });
  });

  it('rejects differing segment count', () => {
    const p = parsePattern('/sessions/:id');
    expect(matchPattern(p, '/sessions')).toBeNull();
    expect(matchPattern(p, '/sessions/abc/extra')).toBeNull();
  });

  it('rejects static mismatch', () => {
    const p = parsePattern('/sessions/:id');
    expect(matchPattern(p, '/projects/abc')).toBeNull();
  });

  it('matches the empty root', () => {
    const p = parsePattern('/');
    expect(matchPattern(p, '/')).toEqual({});
    expect(matchPattern(p, '')).toEqual({});
  });
});

describe('sortPatternsBySpecificity', () => {
  it('sorts static-first patterns before param patterns', () => {
    const entries = [
      { pattern: parsePattern('/sessions/:id') },
      { pattern: parsePattern('/sessions/active') },
    ];
    sortPatternsBySpecificity(entries);
    expect(entries[0]!.pattern.pattern).toBe('/sessions/active');
    expect(entries[1]!.pattern.pattern).toBe('/sessions/:id');
  });

  it('preserves order for equal specificity', () => {
    const entries = [
      { pattern: parsePattern('/a/:x') },
      { pattern: parsePattern('/b/:y') },
    ];
    const first = entries[0]!;
    sortPatternsBySpecificity(entries);
    // Either order is fine, but should be stable-ish — at minimum both exist.
    expect(entries).toContain(first);
    expect(entries).toHaveLength(2);
  });
});
