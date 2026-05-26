// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { parseDelimited, isCsvPath, csvDelimiterFor } from './CsvViewer';

describe('parseDelimited', () => {
  it('parses simple comma-separated rows', () => {
    expect(parseDelimited('a,b,c\n1,2,3', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('parses tab-separated rows', () => {
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseDelimited('a,b\r\n1,2\r\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('does not emit a trailing blank row for a final newline', () => {
    expect(parseDelimited('a,b\n1,2\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('preserves empty fields', () => {
    expect(parseDelimited('a,,c\n,,', ',')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });

  it('respects quoted fields containing the delimiter', () => {
    expect(parseDelimited('"a,b",c', ',')).toEqual([['a,b', 'c']]);
  });

  it('respects quoted fields containing newlines', () => {
    expect(parseDelimited('"line1\nline2",b', ',')).toEqual([['line1\nline2', 'b']]);
  });

  it('unescapes doubled quotes inside quoted fields', () => {
    expect(parseDelimited('"say ""hi""",b', ',')).toEqual([['say "hi"', 'b']]);
  });

  it('handles ragged rows of differing length', () => {
    expect(parseDelimited('a,b,c\n1,2', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2'],
    ]);
  });

  it('returns empty for empty input', () => {
    expect(parseDelimited('', ',')).toEqual([]);
  });

  it('parses a single field with no delimiter', () => {
    expect(parseDelimited('hello', ',')).toEqual([['hello']]);
  });
});

describe('isCsvPath', () => {
  it('matches csv, tsv, and tab extensions case-insensitively', () => {
    expect(isCsvPath('/data/report.csv')).toBe(true);
    expect(isCsvPath('data.TSV')).toBe(true);
    expect(isCsvPath('x.tab')).toBe(true);
  });

  it('rejects non-delimited extensions', () => {
    expect(isCsvPath('notes.md')).toBe(false);
    expect(isCsvPath('script.ts')).toBe(false);
    expect(isCsvPath('README')).toBe(false);
  });
});

describe('csvDelimiterFor', () => {
  it('uses tab for .tsv and .tab', () => {
    expect(csvDelimiterFor('a.tsv')).toBe('\t');
    expect(csvDelimiterFor('a.tab')).toBe('\t');
  });

  it('uses comma for .csv and anything else', () => {
    expect(csvDelimiterFor('a.csv')).toBe(',');
    expect(csvDelimiterFor('a.txt')).toBe(',');
  });
});
