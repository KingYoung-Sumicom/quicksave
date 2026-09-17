// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Restart the daemon after a successful self-update.
 *
 * A daemon started by a systemd user unit must ask systemd to restart that
 * unit. A detached child still belongs to the service cgroup, so systemd
 * kills it while stopping the old daemon. Non-systemd installations retain
 * the detached launcher because they have no supervisor to take over.
 */

import { spawn } from 'child_process';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { startUserUnit, wasLaunchedBySystemd } from './systemdUnit.js';
import { getRunDir } from './singleton.js';

export function requestDaemonRestart(): void {
  if (wasLaunchedBySystemd()) {
    console.log('Update complete — requesting systemd restart...');
    if (!startUserUnit()) {
      console.error('Failed to restart quicksave.service via systemctl --user.');
    }
    return;
  }

  console.log('Update complete — spawning upgrade launcher...');
  const thisFile = fileURLToPath(import.meta.url);
  const isTs = thisFile.endsWith('.ts');
  const entryPath = resolve(dirname(thisFile), isTs ? '../index.ts' : '../index.js');
  const logPath = join(getRunDir(), 'daemon.log');
  const node = process.execPath;
  const nf = isTs ? `--import tsx ` : '';
  const oldPid = process.pid;
  // Escape single quotes in paths for safe shell interpolation
  const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  // Detached shell: verify → kill old → start new.
  // Sanity check + its `||` fallback must stay in a single array element —
  // if we split them and `.join(' && ')`, the result becomes `… && || { … }`
  // which is a shell syntax error and the whole launcher silently aborts.
  const script = [
    `sleep 1`,
    // Sanity-check: if new binary can't even print version, abort
    `${sq(node)} ${nf}${sq(entryPath)} --version > /dev/null 2>&1 || { echo "[upgrade] new binary failed sanity check, aborting" >> ${sq(logPath)}; exit 1; }`,
    // New binary works — kill old daemon (graceful shutdown releases lock)
    `kill ${oldPid}`,
    // Wait for old daemon to fully exit and release lock
    `for i in 1 2 3 4 5; do kill -0 ${oldPid} 2>/dev/null || break; sleep 1; done`,
    // Start new daemon
    `${sq(node)} ${nf}${sq(entryPath)} service run >> ${sq(logPath)} 2>&1`,
  ].join(' && ');
  spawn('sh', ['-c', script], {
    detached: true, stdio: 'ignore', env: process.env,
  }).unref();
}
