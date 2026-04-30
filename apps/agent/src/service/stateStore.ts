// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Persistence for service.json — the daemon's externally-visible state file.
 *
 * Written by the daemon, read by CLI clients for quick pre-checks
 * before attempting IPC connection.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { ServiceState } from './types.js';
import { getStateDir } from './singleton.js';

const SERVICE_JSON = () => join(getStateDir(), 'service.json');

export function readServiceState(): ServiceState | null {
  try {
    const path = SERVICE_JSON();
    if (!existsSync(path)) return null;
    const data = readFileSync(path, 'utf-8');
    return JSON.parse(data) as ServiceState;
  } catch {
    return null;
  }
}

export function writeServiceState(state: ServiceState): void {
  writeFileSync(SERVICE_JSON(), JSON.stringify(state, null, 2));
}

export function removeServiceState(): void {
  try {
    unlinkSync(SERVICE_JSON());
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}
