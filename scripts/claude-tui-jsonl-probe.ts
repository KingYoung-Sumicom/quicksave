#!/usr/bin/env -S npx tsx
// Probe v2: watch ~/.claude/projects/-tmp/ for new jsonl, then poll its size
// at 25ms while a haiku turn streams. Asks for a counting response so the
// text grows visibly over multiple seconds — we want to see whether bytes
// land per-event or only at turn-end.

import * as pty from 'node-pty';
import { statSync, readdirSync, openSync, readSync, closeSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TARGET_DIR = join(homedir(), '.claude', 'projects', '-tmp');
const CWD = '/tmp';

if (!existsSync(TARGET_DIR)) mkdirSync(TARGET_DIR, { recursive: true });
const beforeFiles = new Set(readdirSync(TARGET_DIR).filter(f => f.endsWith('.jsonl')));

const start = Date.now();
const ts = () => `+${((Date.now() - start) / 1000).toFixed(2)}s`;

console.log(`[init] ${ts()} target=${TARGET_DIR} before=${beforeFiles.size}`);

const term = pty.spawn('claude', ['--model', 'claude-haiku-4-5-20251001'], {
  name: 'xterm-256color', cols: 120, rows: 30, cwd: CWD,
  env: process.env as { [key: string]: string },
});

let newPath: string | null = null;
let lastSize = 0;
let lastWriteAt = start;
let writeCount = 0;

setTimeout(() => {
  const prompt = 'Repeat each color name slowly with a pause between: red. orange. yellow. green. blue. purple. pink. brown. black. white.';
  console.log(`[send]     ${ts()} writing prompt`);
  term.write(prompt);
  setTimeout(() => term.write('\r'), 150);
}, 3500);

setInterval(() => {
  if (!newPath) {
    try {
      for (const f of readdirSync(TARGET_DIR)) {
        if (!f.endsWith('.jsonl')) continue;
        if (beforeFiles.has(f)) continue;
        newPath = join(TARGET_DIR, f);
        console.log(`[discover] ${ts()} ${f}`);
        lastSize = statSync(newPath).size;
        return;
      }
    } catch { /* */ }
    return;
  }
  try {
    const s = statSync(newPath);
    if (s.size !== lastSize) {
      const delta = s.size - lastSize;
      const gap = Date.now() - lastWriteAt;
      writeCount++;
      const fd = openSync(newPath, 'r');
      const buf = Buffer.alloc(Math.min(delta, 300));
      readSync(fd, buf, 0, buf.length, lastSize);
      closeSync(fd);
      // Pull just the type field for compactness
      const chunk = buf.toString('utf8');
      const typeMatch = chunk.match(/"type":"([^"]+)"/);
      const evType = typeMatch ? typeMatch[1] : '?';
      console.log(`[write#${writeCount}] ${ts()} +${delta}B gap=${gap}ms type=${evType}`);
      lastSize = s.size;
      lastWriteAt = Date.now();
    }
  } catch { /* */ }
}, 25);

setTimeout(() => {
  console.log(`[exit]     ${ts()} total writes=${writeCount}, killing`);
  try { term.kill(); } catch { /* */ }
  setTimeout(() => process.exit(0), 200);
}, 30_000);

term.onExit(() => setTimeout(() => process.exit(0), 100));
