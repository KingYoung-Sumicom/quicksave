#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Post-build step: replace the __BUILD_ID__ placeholder in the compiled output
 * with a content hash of the dist directory. This ensures production builds
 * are correctly identified as non-dev.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '..', 'dist');
const targetFile = resolve(distDir, 'service', 'types.js');

// Hash all .js files in dist (excluding types.js itself to avoid circular dep)
const hash = createHash('md5');
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
    } else if (entry.name.endsWith('.js') && p !== targetFile) {
      hash.update(readFileSync(p));
    }
  }
})(distDir);

const buildId = hash.digest('hex').slice(0, 12);

const content = readFileSync(targetFile, 'utf8');
const updated = content.replace("'__BUILD_ID__'", `'${buildId}'`);

if (content === updated) {
  console.error('stamp-build-id: placeholder not found in', targetFile);
  process.exit(1);
}

writeFileSync(targetFile, updated);
console.log(`stamp-build-id: ${buildId}`);
