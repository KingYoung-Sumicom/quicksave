// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

export interface ParsedReadToolResult {
  path: string;
  type: 'file' | 'directory';
  content: string;
}

export interface ParsedShellToolResult {
  output: string;
  metadata: string;
  content: string;
}

/**
 * Parse the model-facing wrapper emitted by OpenCode's built-in `read` tool.
 *
 * OpenCode returns files as `<path>/<type>/<content>` and directories as
 * `<path>/<type>/<entries>`. A file result may also append a
 * `<system-reminder>` after the closing content tag; that reminder is for the
 * model and should not be shown in the Read card.
 */
export function parseReadToolResult(result: string): ParsedReadToolResult | null {
  const lines = result.replace(/\r\n/g, '\n').split('\n');
  if (lines.length < 4) return null;

  const pathMatch = lines[0]?.match(/^<path>(.*)<\/path>$/);
  const typeMatch = lines[1]?.match(/^<type>(file|directory)<\/type>$/);
  if (!pathMatch?.[1] || !typeMatch?.[1]) return null;

  const type = typeMatch[1] as ParsedReadToolResult['type'];
  const container = type === 'directory' ? 'entries' : 'content';
  if (lines[2] !== `<${container}>`) return null;

  const closingTag = `</${container}>`;
  let closingIndex = -1;
  for (let i = lines.length - 1; i >= 3; i -= 1) {
    if (lines[i] === closingTag) {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex < 3) return null;

  return {
    path: pathMatch[1],
    type,
    content: lines.slice(3, closingIndex).join('\n'),
  };
}

/**
 * Parse the model-facing metadata trailer emitted by OpenCode's built-in
 * `shell` tool when a command times out or is aborted. Preserve the useful
 * human-readable message while removing the transport wrapper tags.
 */
export function parseShellToolResult(result: string): ParsedShellToolResult | null {
  const normalized = result.replace(/\r\n/g, '\n');
  const marker = '\n\n<shell_metadata>\n';
  const markerIndex = normalized.lastIndexOf(marker);
  const closingTag = '\n</shell_metadata>';
  if (markerIndex < 0 || !normalized.endsWith(closingTag)) return null;

  const metadataStart = markerIndex + marker.length;
  const metadata = normalized.slice(metadataStart, -closingTag.length);
  if (!metadata.trim()) return null;

  const output = normalized.slice(0, markerIndex);
  return {
    output,
    metadata,
    content: output ? `${output}\n\n${metadata}` : metadata,
  };
}
