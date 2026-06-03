// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
// ============================================================================
// Persistent artifact store on the agent.
//
// Generated reports live under:
//
//   <state>/artifacts/<encoded-project-path>/<sessionId>/<artifactId>/
//     artifact.md
//     meta.json
//
// Tool results and cards carry only ArtifactMetadata. The PWA fetches content
// on demand through `artifact:fetch`, keeping large reports out of model
// context and out of card snapshots.
// ============================================================================

import { copyFile, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'fs/promises';
import { basename, extname, isAbsolute, join, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import type { Artifact, ArtifactMetadata, MarkdownArtifactRef } from '@sumicom/quicksave-shared';
import { getArtifactsDir } from '../service/singleton.js';

const ARTIFACT_FILENAME = 'artifact.md';
const META_FILENAME = 'meta.json';
const MARKDOWN_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
const MARKDOWN_ARTIFACT_EXTENSIONS = ['.md', '.markdown'] as const;

function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[\\/]/g, '-').replace(/:/g, '');
}

function dirFor(cwd: string, sessionId: string): string {
  return join(getArtifactsDir(), encodeProjectPath(cwd), sessionId);
}

function artifactDirFor(cwd: string, sessionId: string, artifactId: string): string {
  return join(dirFor(cwd, sessionId), artifactId);
}

function storedMarkdownPath(cwd: string, sessionId: string, artifactId: string): string {
  return join(artifactDirFor(cwd, sessionId, artifactId), ARTIFACT_FILENAME);
}

function metaPathFor(cwd: string, sessionId: string, artifactId: string): string {
  return join(artifactDirFor(cwd, sessionId, artifactId), META_FILENAME);
}

function isPathInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function assertMarkdownPath(filePath: string): void {
  const ext = extname(filePath).toLowerCase();
  if (!MARKDOWN_ARTIFACT_EXTENSIONS.includes(ext as '.md' | '.markdown')) {
    throw new Error('Only .md and .markdown artifacts are supported');
  }
}

export interface PublishMarkdownArtifactArgs {
  sessionId: string;
  cwd: string;
  sourcePath: string;
  title?: string;
}

export async function publishMarkdownArtifact(args: PublishMarkdownArtifactArgs): Promise<MarkdownArtifactRef> {
  const cwdReal = await realpath(args.cwd);
  const requestedSource = isAbsolute(args.sourcePath)
    ? args.sourcePath
    : resolve(cwdReal, args.sourcePath);
  assertMarkdownPath(requestedSource);

  const sourceReal = await realpath(requestedSource);
  if (!isPathInside(sourceReal, cwdReal)) {
    throw new Error('Artifact source must be inside the project directory');
  }

  const st = await stat(sourceReal);
  if (!st.isFile()) {
    throw new Error('Artifact source must be a regular file');
  }
  if (st.size > MARKDOWN_ARTIFACT_MAX_BYTES) {
    throw new Error(`Markdown artifact exceeds ${MARKDOWN_ARTIFACT_MAX_BYTES} byte limit`);
  }

  const artifactId = randomUUID();
  const artifactDir = artifactDirFor(cwdReal, args.sessionId, artifactId);
  await mkdir(artifactDir, { recursive: true });
  await copyFile(sourceReal, storedMarkdownPath(cwdReal, args.sessionId, artifactId));

  const meta: MarkdownArtifactRef = {
    refKind: 'artifact',
    artifactId,
    sessionId: args.sessionId,
    cwd: cwdReal,
    kind: 'markdown',
    title: args.title?.trim() || basename(sourceReal),
    mimeType: 'text/markdown',
    size: st.size,
    createdAt: Date.now(),
    sourcePath: sourceReal,
  };
  await writeFile(metaPathFor(cwdReal, args.sessionId, artifactId), JSON.stringify(meta, null, 2));
  return meta;
}

export async function loadArtifactBySession(sessionId: string, artifactId: string): Promise<Artifact | null> {
  const base = getArtifactsDir();
  let projectDirs: string[];
  try {
    projectDirs = await readdir(base);
  } catch {
    return null;
  }

  for (const projectDir of projectDirs) {
    const artifactDir = join(base, projectDir, sessionId, artifactId);
    try {
      const [metaRaw, bytes] = await Promise.all([
        readFile(join(artifactDir, META_FILENAME), 'utf8'),
        readFile(join(artifactDir, ARTIFACT_FILENAME)),
      ]);
      const meta = JSON.parse(metaRaw) as ArtifactMetadata;
      if (meta.sessionId !== sessionId || meta.artifactId !== artifactId) continue;
      return {
        ...meta,
        contentBase64: bytes.toString('base64'),
      };
    } catch {
      // Keep scanning: sessions can share ids across different project dirs in
      // malformed or hand-edited state, and missing files are local-only.
    }
  }
  return null;
}

export async function listSessionArtifacts(cwd: string, sessionId: string): Promise<ArtifactMetadata[]> {
  let artifactIds: string[];
  try {
    artifactIds = await readdir(dirFor(cwd, sessionId));
  } catch {
    return [];
  }
  const metas: ArtifactMetadata[] = [];
  for (const artifactId of artifactIds) {
    try {
      const raw = await readFile(metaPathFor(cwd, sessionId, artifactId), 'utf8');
      metas.push(JSON.parse(raw) as ArtifactMetadata);
    } catch {
      // skip unreadable metas
    }
  }
  return metas.sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeSessionArtifacts(cwd: string, sessionId: string): Promise<void> {
  try {
    await rm(dirFor(cwd, sessionId), { recursive: true, force: true });
  } catch {
    // best effort
  }
}
