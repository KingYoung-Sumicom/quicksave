// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PushStore, type PushSubscriptionRecord } from './pushStore.js';

const mkRecord = (endpoint: string): PushSubscriptionRecord => ({
  endpoint,
  keys: { p256dh: 'p', auth: 'a' },
  registeredAt: 1,
  lastUsedAt: 1,
});

describe('PushStore', () => {
  let store: PushStore;
  let tmpDir: string;
  let snapshotPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'push-store-'));
    snapshotPath = join(tmpDir, 'snapshot.json');
    store = new PushStore({ path: snapshotPath, flushDebounceMs: 0 });
  });

  afterEach(() => {
    store.flush();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores and lists subscriptions per agent', () => {
    store.add('agentA', mkRecord('https://push/1'));
    store.add('agentA', mkRecord('https://push/2'));
    store.add('agentB', mkRecord('https://push/3'));

    expect(store.list('agentA').map((s) => s.endpoint)).toEqual([
      'https://push/1',
      'https://push/2',
    ]);
    expect(store.list('agentB').map((s) => s.endpoint)).toEqual(['https://push/3']);
    expect(store.list('missing')).toEqual([]);
  });

  it('dedupes when the same endpoint is added twice', () => {
    store.add('agentA', mkRecord('https://push/1'));
    store.add('agentA', { ...mkRecord('https://push/1'), lastUsedAt: 99 });

    const list = store.list('agentA');
    expect(list).toHaveLength(1);
    expect(list[0].lastUsedAt).toBe(99);
  });

  it('removes by endpoint globally and removes empty agent entries', () => {
    store.add('agentA', mkRecord('https://push/1'));
    store.add('agentB', mkRecord('https://push/1'));

    expect(store.removeByEndpoint('https://push/1')).toBe(true);
    expect(store.list('agentA')).toEqual([]);
    expect(store.list('agentB')).toEqual([]);
    expect(store.stats.agents).toBe(0);
  });

  it('removes by endpoint scoped to one agent', () => {
    store.add('agentA', mkRecord('https://push/1'));
    store.add('agentB', mkRecord('https://push/1'));

    store.removeByEndpoint('https://push/1', 'agentA');
    expect(store.list('agentA')).toEqual([]);
    expect(store.list('agentB').map((s) => s.endpoint)).toEqual(['https://push/1']);
  });

  it('persists to disk and reloads', () => {
    store.add('agentA', mkRecord('https://push/1'));
    store.flush();

    expect(existsSync(snapshotPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    expect(parsed.version).toBe(1);

    const reloaded = new PushStore({ path: snapshotPath, flushDebounceMs: 0 });
    expect(reloaded.list('agentA').map((s) => s.endpoint)).toEqual(['https://push/1']);
  });

  it('ignores snapshots with an unknown version', () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    writeFileSync(snapshotPath, JSON.stringify({ version: 99, entries: { a: [mkRecord('x')] } }));
    const loaded = new PushStore({ path: snapshotPath, flushDebounceMs: 0 });
    expect(loaded.list('a')).toEqual([]);
  });

  it('touch updates lastUsedAt', () => {
    store.add('agentA', mkRecord('https://push/1'));
    store.touch('agentA', 'https://push/1', 500);
    expect(store.list('agentA')[0].lastUsedAt).toBe(500);
  });

  it('reports stats', () => {
    store.add('agentA', mkRecord('https://push/1'));
    store.add('agentA', mkRecord('https://push/2'));
    store.add('agentB', mkRecord('https://push/3'));
    expect(store.stats).toEqual({ agents: 2, subscriptions: 3 });
  });
});
