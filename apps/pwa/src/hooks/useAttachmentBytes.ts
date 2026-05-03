// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import type {
  Attachment,
  AttachmentFetchRequestPayload,
  AttachmentFetchResponsePayload,
} from '@sumicom/quicksave-shared';
import { readAttachmentWithCache } from '../lib/attachmentCache';
import { getActiveBus } from '../lib/busRegistry';

export type AttachmentBytesState =
  | { status: 'loading' }
  | { status: 'ready'; attachment: Attachment }
  | { status: 'error'; error: string };

/**
 * Resolve attachment bytes for a chip rendered from `UserCard.attachments`.
 * Goes through the L1+L2 cache; only crosses the wire on the first miss.
 *
 * `null` ids/sessions short-circuit to a stable loading state — handy for
 * conditional rendering before the card's full set is known.
 */
export function useAttachmentBytes(
  sessionId: string | null | undefined,
  attachmentId: string | null | undefined,
): AttachmentBytesState {
  const [state, setState] = useState<AttachmentBytesState>({ status: 'loading' });

  useEffect(() => {
    if (!sessionId || !attachmentId) {
      setState({ status: 'loading' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });

    readAttachmentWithCache({ sessionId, attachmentId }, fetchAttachmentBytes)
      .then((attachment) => {
        if (cancelled) return;
        setState({ status: 'ready', attachment });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load attachment';
        setState({ status: 'error', error: message });
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, attachmentId]);

  return state;
}

async function fetchAttachmentBytes(req: AttachmentFetchRequestPayload): Promise<Attachment> {
  const bus = getActiveBus();
  if (!bus) throw new Error('Not connected');
  const res = await bus.command<AttachmentFetchResponsePayload, AttachmentFetchRequestPayload>(
    'attachment:fetch',
    req,
    { timeoutMs: 30_000, queueWhileDisconnected: true },
  );
  return res.attachment;
}
