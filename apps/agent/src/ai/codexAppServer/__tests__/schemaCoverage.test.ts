// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

describe('Codex app-server schema coverage', () => {
  it('handles every generated server request method', () => {
    const generated = generatedMethods('../schema/generated/ServerRequest.ts');
    const handled = switchCases('../provider.ts');

    expect(generated.filter((method) => !handled.includes(method))).toEqual([]);
  });

  it('has an explicit adapter case for every generated notification method', () => {
    const generated = generatedMethods('../schema/generated/ServerNotification.ts');
    const handled = switchCases('../cardAdapter.ts');

    expect(generated.filter((method) => !handled.includes(method))).toEqual([]);
  });

  it('has an explicit adapter case for every generated ThreadItem type', () => {
    const generated = generatedTypes('../schema/generated/v2/ThreadItem.ts');
    const handled = switchCases('../cardAdapter.ts');

    expect(generated.filter((type) => !handled.includes(type))).toEqual([]);
  });
});

function generatedMethods(path: string): string[] {
  return uniqueMatches(read(path), /"method": "([^"]+)"/g);
}

function generatedTypes(path: string): string[] {
  return uniqueMatches(read(path), /"type": "([^"]+)"/g);
}

function switchCases(path: string): string[] {
  return uniqueMatches(read(path), /case '([^']+)'/g);
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  return [...new Set(Array.from(text.matchAll(pattern), (match) => match[1]))].sort();
}

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}
