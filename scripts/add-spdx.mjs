#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HOLDER = 'King Young Technology';
const YEAR = '2026';
const LICENSE = 'MIT';

const SCAN_ROOTS = ['apps', 'packages'];
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const SKIP_DIR_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo',
  '.cache', '.parcel-cache', 'out', '.vite', '.swc',
  'generated', '__generated__',
]);

function shouldSkip(path) {
  if (path.endsWith('.d.ts')) return true;
  return path.split('/').some((seg) => SKIP_DIR_SEGMENTS.has(seg));
}

function listFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--', ...SCAN_ROOTS],
    { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean);

  return out
    .filter((p) => EXTS.has(p.slice(p.lastIndexOf('.'))))
    .filter((p) => !shouldSkip(p));
}

function buildHeader(commentStart) {
  return [
    `${commentStart} SPDX-FileCopyrightText: ${YEAR} ${HOLDER}`,
    `${commentStart} SPDX-License-Identifier: ${LICENSE}`,
    '',
  ].join('\n');
}

async function patch(file) {
  const abs = join(REPO_ROOT, file);
  const original = await readFile(abs, 'utf8');

  if (original.includes('SPDX-License-Identifier')) {
    return { file, action: 'skip-existing' };
  }

  const header = buildHeader('//');

  let next;
  if (original.startsWith('#!')) {
    const nl = original.indexOf('\n');
    if (nl === -1) {
      next = `${original}\n${header}`;
    } else {
      next = `${original.slice(0, nl + 1)}${header}${original.slice(nl + 1)}`;
    }
  } else {
    next = `${header}${original}`;
  }

  await writeFile(abs, next, 'utf8');
  return { file, action: 'patched' };
}

async function main() {
  const files = listFiles();
  let patched = 0;
  let skipped = 0;

  for (const file of files) {
    const result = await patch(file);
    if (result.action === 'patched') patched += 1;
    else skipped += 1;
  }

  console.log(`SPDX sweep: ${patched} patched, ${skipped} already had it. Total considered: ${files.length}.`);
  console.log(`Holder: "${YEAR} ${HOLDER}" · License: ${LICENSE}`);
  console.log(`Roots: ${SCAN_ROOTS.join(', ')} (relative to ${relative(process.cwd(), REPO_ROOT) || '.'})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
