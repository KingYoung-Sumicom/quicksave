// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { Card, MarkdownArtifactRef, ToolCallCard } from '@sumicom/quicksave-shared';
import { parseMarkdownArtifactRef, shouldCollapseCard } from './cardCollapse';

const artifact: MarkdownArtifactRef = {
  refKind: 'artifact',
  kind: 'markdown',
  artifactId: 'artifact-1',
  sessionId: 'session-1',
  cwd: '/project',
  title: 'Report',
  mimeType: 'text/markdown',
  size: 42,
  createdAt: 123,
};

function toolCall(overrides: Partial<ToolCallCard> = {}): ToolCallCard {
  return {
    type: 'tool_call',
    id: 'tool-1',
    timestamp: 123,
    toolName: 'Bash',
    toolInput: {},
    toolUseId: 'tool-use-1',
    ...overrides,
  };
}

describe('shouldCollapseCard', () => {
  it('keeps standalone artifact cards visible after a turn completes', () => {
    const card: Card = {
      type: 'artifact',
      id: 'artifact-card-1',
      timestamp: 123,
      artifact,
      isTurnIntermediate: true,
      turnCompleted: true,
    };

    expect(shouldCollapseCard(card, true, true)).toBe(false);
  });

  it('keeps artifact tool results visible when tool calls are hidden', () => {
    const card = toolCall({
      result: {
        content: JSON.stringify(artifact),
        isError: false,
        truncated: false,
      },
    });

    expect(shouldCollapseCard(card, true, true)).toBe(false);
  });

  it('still collapses ordinary tool calls', () => {
    expect(shouldCollapseCard(toolCall(), false, true)).toBe(true);
    expect(shouldCollapseCard(toolCall(), true, false)).toBe(true);
  });

  it('preserves interactive tool visibility for preference-based folding only', () => {
    const card = toolCall({ toolName: 'AskUserQuestion' });

    expect(shouldCollapseCard(card, false, true)).toBe(false);
    expect(shouldCollapseCard(card, true, true)).toBe(true);
  });
});

describe('parseMarkdownArtifactRef', () => {
  it('accepts both decoded values and JSON tool results', () => {
    expect(parseMarkdownArtifactRef(artifact)).toEqual(artifact);
    expect(parseMarkdownArtifactRef(JSON.stringify(artifact))).toEqual(artifact);
  });

  it('rejects malformed and error-like values', () => {
    expect(parseMarkdownArtifactRef('not json')).toBeNull();
    expect(parseMarkdownArtifactRef({ ...artifact, mimeType: 'text/plain' })).toBeNull();
  });
});
