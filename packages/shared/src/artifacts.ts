// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
// ============================================================================
// Artifact types — agent-owned display outputs such as generated Markdown
// reports. Cards and tool results carry metadata only; bytes are fetched on
// demand so large reports do not enter model context or card snapshots.
// ============================================================================

export type ArtifactKind = 'markdown';

export interface ArtifactMetadata {
  artifactId: string;
  sessionId: string;
  cwd: string;
  kind: ArtifactKind;
  title: string;
  mimeType: 'text/markdown';
  size: number;
  createdAt: number;
  sourcePath?: string;
}

export interface Artifact extends ArtifactMetadata {
  /** Base64 of the artifact bytes. For markdown this is base64(utf8 bytes). */
  contentBase64: string;
}

export interface ArtifactFetchRequestPayload {
  sessionId: string;
  artifactId: string;
}

export interface ArtifactFetchResponsePayload {
  artifact: Artifact;
}

export interface MarkdownArtifactRef extends ArtifactMetadata {
  kind: 'markdown';
  refKind: 'artifact';
}

export const ARTIFACT_LIMITS = {
  markdown: {
    maxBytes: 10 * 1024 * 1024,
    extensions: ['.md', '.markdown'] as const,
  },
} as const;
