// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

const SAFE_ATTACHMENT_PATH_SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isSafeAttachmentPathSegment(value: unknown): value is string {
  return typeof value === 'string'
    && SAFE_ATTACHMENT_PATH_SEGMENT_RE.test(value)
    && value !== '.'
    && value !== '..';
}

export function assertSafeAttachmentPathSegment(label: string, value: unknown): asserts value is string {
  if (!isSafeAttachmentPathSegment(value)) {
    throw new Error(`${label} must be a safe path segment`);
  }
}
