// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { Attachment, SessionQueueState } from '@sumicom/quicksave-shared';

const QUEUE_PREVIEW_MAX = 80;

export interface QueuedUserPrompt {
  prompt: string;
  attachments?: readonly Attachment[];
}

export function previewQueuedPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length > QUEUE_PREVIEW_MAX
    ? `${normalized.slice(0, QUEUE_PREVIEW_MAX - 3)}...`
    : normalized;
}

export function queueStateFor(
  queued: readonly QueuedUserPrompt[],
  canInterruptCurrentTurn: boolean,
): SessionQueueState | null {
  if (queued.length === 0) return null;
  const queuedPromptPreviews = queued.map((turn) => previewQueuedPrompt(turn.prompt));
  return {
    pendingUserMessages: queued.length,
    latestPromptPreview: queuedPromptPreviews[queuedPromptPreviews.length - 1],
    queuedPromptPreviews,
    canInterruptCurrentTurn,
  };
}
