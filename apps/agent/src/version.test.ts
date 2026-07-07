// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION } from './version.js';

describe('PACKAGE_VERSION', () => {
  it('matches apps/agent/package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      version?: unknown;
    };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
