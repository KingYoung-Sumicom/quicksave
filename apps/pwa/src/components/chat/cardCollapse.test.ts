// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { Card, MarkdownArtifactRef, ToolCallCard } from '@sumicom/quicksave-shared';
import {
  filterRenderableCards,
  isEmptyMarkdownTextCard,
  parseMarkdownArtifactRef,
  shouldCollapseCard,
} from './cardCollapse';

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

  it('keeps system errors visible after a turn completes', () => {
    const card: Card = {
      type: 'system',
      id: 'usage-limit-error',
      timestamp: 123,
      text: "Error: You've hit your usage limit.",
      subtype: 'error',
    };

    expect(shouldCollapseCard(card, true, true)).toBe(false);
  });

  it('keeps system warnings visible after a turn completes', () => {
    const card: Card = {
      type: 'system',
      id: 'warning',
      timestamp: 123,
      text: 'Account verification required.',
      subtype: 'warning',
    };

    expect(shouldCollapseCard(card, true, true)).toBe(false);
  });

  it('folds thinking cards into preference-based tool-call groups', () => {
    const card: Card = {
      type: 'thinking',
      id: 'thinking-1',
      timestamp: 123,
      text: 'Considering the next tool call',
    };

    expect(shouldCollapseCard(card, false, true)).toBe(true);
    expect(shouldCollapseCard(card, false, false)).toBe(false);
  });

  it('preserves interactive tool visibility for preference-based folding only', () => {
    const card = toolCall({ toolName: 'AskUserQuestion' });

    expect(shouldCollapseCard(card, false, true)).toBe(false);
    expect(shouldCollapseCard(card, true, true)).toBe(true);
  });
});

describe('empty Markdown text cards', () => {
  it('treats whitespace-only assistant text as non-renderable', () => {
    const card: Card = {
      type: 'assistant_text',
      id: 'empty-markdown',
      timestamp: 123,
      text: '\n\n  ',
    };

    expect(isEmptyMarkdownTextCard(card)).toBe(true);
  });

  it('removes empty Markdown before tool-call grouping sees the sequence', () => {
    const first = toolCall({ id: 'tool-1', toolUseId: 'call-1' });
    const empty: Card = {
      type: 'assistant_text',
      id: 'empty-markdown',
      timestamp: 124,
      text: '\n\n',
    };
    const second = toolCall({ id: 'tool-2', toolUseId: 'call-2' });

    expect(filterRenderableCards([first, empty, second])).toEqual([first, second]);
  });

  it('preserves visible Markdown and non-Markdown cards', () => {
    const visible: Card = {
      type: 'assistant_text',
      id: 'visible-markdown',
      timestamp: 123,
      text: '\n\nHello',
    };
    const user: Card = {
      type: 'user',
      id: 'empty-user',
      timestamp: 124,
      text: '',
    };

    expect(filterRenderableCards([visible, user])).toEqual([visible, user]);
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
