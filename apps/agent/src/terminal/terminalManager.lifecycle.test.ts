// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import headless from '@xterm/headless';
import type { TerminalSummary, TerminalsUpdate } from '@sumicom/quicksave-shared';
import { TerminalManager } from './terminalManager.js';

const ptyState = vi.hoisted(() => ({
  onData: null as ((data: string) => void) | null,
  onExit: null as ((event: { exitCode: number; signal: number }) => void) | null,
  kill: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: (handler: (data: string) => void) => { ptyState.onData = handler; },
    onExit: (handler: (event: { exitCode: number; signal: number }) => void) => { ptyState.onExit = handler; },
    write: vi.fn(),
    resize: vi.fn(),
    kill: ptyState.kill,
  }),
}));

describe('TerminalManager lifecycle', () => {
  let manager: TerminalManager;

  beforeEach(() => {
    ptyState.onData = null;
    ptyState.onExit = null;
    ptyState.kill.mockReset();
    manager = new TerminalManager();
  });

  afterEach(() => manager.shutdown());

  it('does not upsert a closed terminal when its PTY reports exit later', async () => {
    const events: Array<TerminalsUpdate | { kind: 'summary'; terminal: TerminalSummary }> = [];
    manager.on('terminals-updated', (event: TerminalsUpdate) => events.push(event));
    manager.on('terminal-updated', (terminal: TerminalSummary) => events.push({ kind: 'summary', terminal }));
    const terminal = await manager.create({ cwd: '/work' });

    manager.close(terminal.terminalId, true);
    ptyState.onExit?.({ exitCode: 0, signal: 0 });

    expect(events.map((event) => event.kind)).toEqual(['upsert', 'remove']);
    expect(manager.listSummaries()).toHaveLength(0);
  });

  it('keeps a terminal reachable when the PTY rejects close', async () => {
    const terminal = await manager.create({ cwd: '/work' });
    ptyState.kill.mockImplementationOnce(() => { throw new Error('kill denied'); });

    expect(() => manager.close(terminal.terminalId, true)).toThrow('kill denied');
    expect(manager.listSummaries().map((item) => item.terminalId)).toContain(terminal.terminalId);
  });

  it('keeps the current screen recoverable after raw output exceeds the old scrollback limit', async () => {
    const terminal = await manager.create({ cwd: '/work' });
    ptyState.onData?.('KEEP' + '\r'.repeat(262_150));

    const snapshot = await manager.outputSnapshot(terminal.terminalId);
    expect(snapshot?.buffer).toContain('KEEP');
    expect(snapshot?.seq).toBeGreaterThan(262_144);

    const restored = new headless.Terminal({ cols: snapshot!.cols, rows: snapshot!.rows, allowProposedApi: true });
    await new Promise<void>((resolve) => restored.write(snapshot!.buffer, resolve));
    expect(restored.buffer.active.getLine(0)?.translateToString()).toContain('KEEP');
    restored.dispose();
  });

  it('restores an alternate-screen TUI from its serialized snapshot', async () => {
    const terminal = await manager.create({ cwd: '/work' });
    ptyState.onData?.('\x1b[?1049h\x1b[HEDITOR');

    const snapshot = await manager.outputSnapshot(terminal.terminalId);
    const restored = new headless.Terminal({ cols: snapshot!.cols, rows: snapshot!.rows, allowProposedApi: true });
    await new Promise<void>((resolve) => restored.write(snapshot!.buffer, resolve));

    expect(restored.buffer.active.type).toBe('alternate');
    expect(restored.buffer.active.getLine(0)?.translateToString()).toContain('EDITOR');
    restored.dispose();
  });

  it('flushes pending live output before capturing the same sequence in a snapshot', async () => {
    const chunks: Array<{ seq: number; chunk: string }> = [];
    manager.on('output', (chunk: { seq: number; chunk: string }) => chunks.push(chunk));
    const terminal = await manager.create({ cwd: '/work' });
    ptyState.onData?.('first line\r\n');

    const snapshot = await manager.outputSnapshot(terminal.terminalId);

    expect(chunks).toEqual([{ terminalId: terminal.terminalId, seq: 12, chunk: 'first line\r\n' }]);
    expect(snapshot?.seq).toBe(chunks[0].seq);
    expect(snapshot?.buffer).toContain('first line');
  });

  it('leaves output arriving after snapshot capture for the next live chunk', async () => {
    const terminal = await manager.create({ cwd: '/work' });
    ptyState.onData?.('first');
    const snapshotPromise = manager.outputSnapshot(terminal.terminalId);
    ptyState.onData?.('second');

    const snapshot = await snapshotPromise;
    expect(snapshot?.seq).toBe(5);
    expect(snapshot?.buffer).toContain('first');
    expect(snapshot?.buffer).not.toContain('second');
  });
});
