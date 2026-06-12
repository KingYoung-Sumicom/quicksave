// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import type { RequestId } from './schema/generated/RequestId.js';

export function codexServerRequestInputId(threadId: string, requestId: RequestId | string | number): string {
  return `codex:${threadId}:${String(requestId)}`;
}
