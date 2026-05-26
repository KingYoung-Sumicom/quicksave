// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useMemo } from 'react';

/**
 * Renders CSV/TSV content as a scrollable table with a sticky header row
 * and a sticky row-number gutter. The parser handles RFC-4180 quoting
 * (double-quote escaping, delimiters and newlines inside quoted fields)
 * plus both LF and CRLF line endings.
 */
export function CsvViewer({
  content,
  delimiter,
}: {
  content: string;
  delimiter: ',' | '\t';
}) {
  const rows = useMemo(() => parseDelimited(content, delimiter), [content, delimiter]);

  if (rows.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-slate-500">
        Empty file — nothing to display.
      </div>
    );
  }

  const [header, ...body] = rows;
  const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);

  return (
    <div className="overflow-auto">
      <table className="border-collapse text-[12px] font-mono text-slate-200">
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-20 bg-slate-900 border-b border-r border-slate-700 px-2 py-1 text-right text-slate-500 select-none">
              #
            </th>
            {Array.from({ length: columnCount }).map((_, c) => (
              <th
                key={c}
                className="sticky top-0 z-10 bg-slate-900 border-b border-r border-slate-700 px-2 py-1 text-left font-semibold whitespace-pre text-slate-100"
              >
                {header[c] ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} className="even:bg-slate-800/40 hover:bg-slate-700/40">
              <td className="sticky left-0 z-10 bg-slate-900 border-b border-r border-slate-700 px-2 py-1 text-right text-slate-500 select-none">
                {r + 1}
              </td>
              {Array.from({ length: columnCount }).map((_, c) => (
                <td
                  key={c}
                  className="border-b border-r border-slate-700/60 px-2 py-1 whitespace-pre align-top"
                >
                  {row[c] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Minimal RFC-4180-style parser. Returns an array of rows, each an array of
 * cell strings. Empty trailing newline does not produce a spurious blank row.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === delimiter) {
      pushField();
      i += 1;
    } else if (ch === '\n') {
      pushRow();
      i += 1;
    } else if (ch === '\r') {
      pushRow();
      if (text[i + 1] === '\n') i += 2;
      else i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }

  // Flush the final field/row unless the input ended exactly on a row break
  // (which already pushed a complete row and reset the accumulators).
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  return rows;
}

export function isCsvPath(filePath: string): boolean {
  const name = (filePath.split('/').pop() ?? '').toLowerCase();
  return name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.tab');
}

export function csvDelimiterFor(filePath: string): ',' | '\t' {
  const name = (filePath.split('/').pop() ?? '').toLowerCase();
  return name.endsWith('.tsv') || name.endsWith('.tab') ? '\t' : ',';
}
