// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * Workspace memory for the voice intermediary — a plain, human-editable
 * markdown file, NOT a database. Mirrors the `AGENTS.md` / Claude-memory model:
 * standing preferences, decisions (trust boundaries) and project facts the
 * "AI coworker" should carry between voice sessions.
 *
 * Two tiers, both optional, loaded together (global first, workspace second so
 * project rules win on conflict):
 *   - global    `~/.quicksave/voice-memory.md`        (cross-project style)
 *   - workspace `<cwd>/.quicksave/voice-memory.md`    (per-project boundaries)
 *
 * Deliberately separate from the coding agent's own `CLAUDE.md` / `AGENTS.md`:
 * those steer the coding agent, so writing coworker notes there would pollute
 * its context. We READ those elsewhere for grounding but only WRITE here.
 */
import { homedir } from 'os';
import { join, dirname } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';

export type MemorySection = 'preference' | 'decision' | 'fact' | 'note';

/** Section slug → human-readable markdown header (the file is for human eyes). */
const SECTION_HEADERS: Record<MemorySection, string> = {
  preference: '偏好',
  decision: '常駐決定（界線）',
  fact: '專案常識',
  note: '筆記',
};

export function globalMemoryPath(): string {
  return join(homedir(), '.quicksave', 'voice-memory.md');
}

export function workspaceMemoryPath(cwd: string): string {
  return join(cwd, '.quicksave', 'voice-memory.md');
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim().length > 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Load the combined memory text for a workspace, ready to splice into the
 * brain's system prompt. Returns '' when nothing has been remembered yet so the
 * caller can cheaply skip the section.
 */
export async function loadMemory(cwd: string): Promise<string> {
  const [global, workspace] = await Promise.all([
    readIfPresent(globalMemoryPath()),
    readIfPresent(workspaceMemoryPath(cwd)),
  ]);
  const parts: string[] = [];
  if (global) parts.push(`# 跨專案記憶 (global)\n\n${global}`);
  if (workspace) parts.push(`# 此工作區記憶 (workspace)\n\n${workspace}`);
  return parts.join('\n\n');
}

/**
 * Append a remembered fact to the WORKSPACE memory file under its section,
 * creating the file/section as needed. Append-only and idempotent on exact
 * duplicates so repeated "remember X" doesn't pile up identical bullets.
 */
export async function appendMemory(
  cwd: string,
  note: string,
  section: MemorySection = 'note',
): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) return;
  const path = workspaceMemoryPath(cwd);
  const existing = (await readIfPresent(path)) ?? '';
  const next = upsertBullet(existing, SECTION_HEADERS[section], trimmed);
  if (next === existing) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
}

/**
 * Pure markdown transform: ensure `- <bullet>` exists under `## <header>`.
 * Inserts the bullet at the end of an existing section, or appends a fresh
 * section. Exported for unit testing.
 */
export function upsertBullet(content: string, header: string, bullet: string): string {
  const bulletLine = `- ${bullet}`;
  const lines = content.length > 0 ? content.split('\n') : [];

  // Already present anywhere → no-op (cheap dedupe).
  if (lines.some((l) => l.trim() === bulletLine)) return content;

  const headerLine = `## ${header}`;
  const headerIdx = lines.findIndex((l) => l.trim() === headerLine);

  if (headerIdx === -1) {
    const block = `${headerLine}\n${bulletLine}`;
    return lines.length > 0 ? `${content.replace(/\n+$/, '')}\n\n${block}` : block;
  }

  // Find the end of this section (next `## ` header or EOF) and insert before it.
  let insertAt = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      insertAt = i;
      break;
    }
  }
  // Trim trailing blank lines inside the section before inserting.
  let tail = insertAt;
  while (tail > headerIdx + 1 && lines[tail - 1].trim() === '') tail--;
  lines.splice(tail, 0, bulletLine);
  return lines.join('\n');
}
