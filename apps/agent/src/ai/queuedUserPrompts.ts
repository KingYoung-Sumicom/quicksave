// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
import type { Attachment, SessionQueueState } from '@sumicom/quicksave-shared';

const QUEUE_PREVIEW_MAX = 80;

export interface QueuedUserPrompt {
  /** Stable id assigned at enqueue time. Lets the PWA target a specific queued
   * message for deletion even as the queue advances (positions shift). */
  id: string;
  prompt: string;
  attachments?: readonly Attachment[];
}

/** Build a queued prompt with a fresh id. Use this at every enqueue site so id
 * generation stays in one place and no provider forgets to assign one. */
export function makeQueuedUserPrompt(
  prompt: string,
  attachments?: readonly Attachment[],
): QueuedUserPrompt {
  return { id: randomUUID(), prompt, attachments };
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
    queuedPromptIds: queued.map((turn) => turn.id),
    canInterruptCurrentTurn,
  };
}
