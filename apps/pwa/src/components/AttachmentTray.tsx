// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { PendingAttachment } from '../lib/attachmentUploader';
import { ComposerChip } from './AttachmentChip';

/** Strip of composer chips above the textarea. */
export function AttachmentTray({
  pending,
  onRemove,
  disabled = false,
}: {
  pending: PendingAttachment[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  if (pending.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-1.5">
      {pending.map((p) => (
        <ComposerChip key={p.id} pending={p} onRemove={disabled ? undefined : () => onRemove(p.id)} />
      ))}
    </div>
  );
}
