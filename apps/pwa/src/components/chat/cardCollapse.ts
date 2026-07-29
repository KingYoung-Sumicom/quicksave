// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { Card, MarkdownArtifactRef } from '@sumicom/quicksave-shared';

const ALWAYS_VISIBLE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'TodoWrite']);

export function isEmptyMarkdownTextCard(card: Card): boolean {
  return card.type === 'assistant_text' && card.text.trim().length === 0;
}

export function filterRenderableCards(cards: readonly Card[]): Card[] {
  return cards.filter((card) => !isEmptyMarkdownTextCard(card));
}

export function parseMarkdownArtifactRef(value: unknown): MarkdownArtifactRef | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const ref = parsed as Record<string, unknown>;
  if (ref.refKind !== 'artifact' || ref.kind !== 'markdown') return null;
  if (
    typeof ref.artifactId !== 'string' ||
    typeof ref.sessionId !== 'string' ||
    typeof ref.cwd !== 'string' ||
    typeof ref.title !== 'string' ||
    ref.mimeType !== 'text/markdown' ||
    typeof ref.size !== 'number' ||
    typeof ref.createdAt !== 'number'
  ) {
    return null;
  }
  return ref as unknown as MarkdownArtifactRef;
}

function cardContainsArtifact(card: Card): boolean {
  if (card.type === 'artifact') return true;
  return card.type === 'tool_call'
    && card.result?.isError !== true
    && parseMarkdownArtifactRef(card.result?.content) !== null;
}

export function shouldCollapseCard(
  card: Card,
  collapseIntermediate: boolean,
  hideToolCalls: boolean,
): boolean {
  // Artifacts are user-facing deliverables, even when transported as a tool
  // result. They must split a folded run instead of disappearing inside it.
  if (cardContainsArtifact(card)) return false;
  if (collapseIntermediate) return true;
  return hideToolCalls
    && (
      card.type === 'thinking'
      || (card.type === 'tool_call' && !ALWAYS_VISIBLE_TOOLS.has(card.toolName))
    );
}
