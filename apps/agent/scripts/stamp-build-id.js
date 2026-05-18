#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Post-build step: replace the __BUILD_ID__ placeholder in the compiled output
 * with a content hash of the dist directory. This ensures production builds
 * are correctly identified as non-dev.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, '..', 'src');
const distDir = resolve(__dirname, '..', 'dist');
const targetFile = resolve(distDir, 'service', 'types.js');

// Copy non-TS assets that tsc doesn't include
const assetPatterns = [/\.sb$/];
(function copyAssets(srcBase, distBase) {
  for (const entry of readdirSync(srcBase, { withFileTypes: true })) {
    const srcPath = resolve(srcBase, entry.name);
    const destPath = resolve(distBase, entry.name);
    if (entry.isDirectory()) {
      copyAssets(srcPath, destPath);
    } else if (assetPatterns.some((re) => re.test(entry.name))) {
      mkdirSync(distBase, { recursive: true });
      cpSync(srcPath, destPath);
    }
  }
})(srcDir, distDir);
console.log('stamp-build-id: assets copied');

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
