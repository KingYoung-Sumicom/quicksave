// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

const DEFAULT_PREVIEW_LIMIT = 2_000;

export function codexProtocolPreview(value: unknown, limit = DEFAULT_PREVIEW_LIMIT): string {
  let text: string;
  try {
    text = JSON.stringify(value, (_key, nested) =>
      typeof nested === 'bigint' ? nested.toString() : nested,
    );
  } catch {
    text = String(value);
  }
  if (!text) return String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}...<truncated>`;
}
