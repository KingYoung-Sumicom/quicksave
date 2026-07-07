// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let i = 0; i < 8; i += 1) {
    const packagePath = join(dir, 'package.json');
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === '@sumicom/quicksave' && typeof pkg.version === 'string') {
        return pkg.version;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error('Unable to locate @sumicom/quicksave package.json');
}

export const PACKAGE_VERSION = findPackageVersion();
