// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileSync, appendFileSync, unlinkSync, existsSync } from 'node:fs';
import { JsonlTail } from '../jsonlTail.js';

const tempPath = () => join(tmpdir(), `qs-jsonl-${randomBytes(4).toString('hex')}.jsonl`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('JsonlTail', () => {
  const cleanup: string[] = [];
  const tails: JsonlTail[] = [];

  afterEach(() => {
    for (const t of tails) t.stop();
    tails.length = 0;
    for (const p of cleanup) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* */ }
    }
    cleanup.length = 0;
  });

  it('reads existing content on start when offset=0', async () => {
    const p = tempPath();
    cleanup.push(p);
    writeFileSync(p, '{"type":"user","content":"hi"}\n{"type":"assistant","content":"hello"}\n');

    const tail = new JsonlTail(p);
    tails.push(tail);
    const seen: unknown[] = [];
    tail.on('message', (m) => seen.push(m));
    tail.start(20);

    await sleep(100);
    expect(seen).toHaveLength(2);
    expect((seen[0] as { type: string }).type).toBe('user');
    expect((seen[1] as { type: string }).type).toBe('assistant');
  });

  it('skips content before startOffset', async () => {
    const p = tempPath();
    cleanup.push(p);
    const first = '{"type":"user","content":"old"}\n';
    writeFileSync(p, first);

    const tail = new JsonlTail(p, Buffer.byteLength(first, 'utf8'));
    tails.push(tail);
    const seen: unknown[] = [];
    tail.on('message', (m) => seen.push(m));
    tail.start(20);

    await sleep(50);
    expect(seen).toHaveLength(0);

    appendFileSync(p, '{"type":"assistant","content":"new"}\n');
    await sleep(100);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { content: string }).content).toBe('new');
  });

  it('waits for a file that does not exist yet, then catches up', async () => {
    const p = tempPath();
    cleanup.push(p);

    const tail = new JsonlTail(p);
    tails.push(tail);
    const seen: unknown[] = [];
    tail.on('message', (m) => seen.push(m));
    tail.start(20);

    await sleep(50);
    expect(seen).toHaveLength(0);

    writeFileSync(p, '{"type":"system","subtype":"init"}\n');
    await sleep(150);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect((seen[0] as { subtype: string }).subtype).toBe('init');
  });

  it('advances currentOffset as messages are read', async () => {
    const p = tempPath();
    cleanup.push(p);
    const line = '{"type":"user"}\n';
    writeFileSync(p, line);

    const tail = new JsonlTail(p);
    tails.push(tail);
    tail.start(20);

    await sleep(50);
    expect(tail.currentOffset).toBe(Buffer.byteLength(line, 'utf8'));
  });

  it('handles malformed lines by emitting error and continuing', async () => {
    const p = tempPath();
    cleanup.push(p);
    writeFileSync(p, 'not json\n{"type":"ok"}\n');

    const tail = new JsonlTail(p);
    tails.push(tail);
    const seen: unknown[] = [];
    const errors: Error[] = [];
    tail.on('message', (m) => seen.push(m));
    tail.on('error', (e) => errors.push(e));
    tail.start(20);

    await sleep(50);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { type: string }).type).toBe('ok');
  });
});
