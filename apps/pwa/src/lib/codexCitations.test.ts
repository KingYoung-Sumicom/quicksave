// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { normalizeCodexFileCitations } from './codexCitations';

describe('normalizeCodexFileCitations', () => {
  it('converts a Codex citation header into an explicit Markdown file link', () => {
    const path = '/Users/jimmy/Documents/P3768_A04_OrCAD_schematics(base_version).pdf';
    const input = `:codex-file-citation{path="${path}" purpose="source"}`;
    const output = normalizeCodexFileCitations(input);

    expect(output).toContain('Source · P3768_A04_OrCAD_schematics(base_version).pdf');
    expect(output).toContain('/Users/jimmy/Documents/P3768_A04_OrCAD_schematics%28base_version%29.pdf');
    expect(output).not.toContain(':codex-file-citation');
  });

  it('preserves malformed directives', () => {
    const input = ':codex-file-citation{purpose="source"}';
    expect(normalizeCodexFileCitations(input)).toBe(input);
  });
});
