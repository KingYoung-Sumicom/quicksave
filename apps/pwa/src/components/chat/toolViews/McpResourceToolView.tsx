// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

type McpResourceAction = 'list' | 'list-templates' | 'read';

const LABELS: Record<McpResourceAction, string> = {
  list: 'List MCP resources',
  'list-templates': 'List MCP templates',
  read: 'Read MCP resource',
};

function McpResourceToolView({
  input,
  action,
  headerSuffix,
}: {
  input: Record<string, unknown>;
  action: McpResourceAction;
  headerSuffix?: ReactNode;
}) {
  const server = typeof input.server === 'string' && input.server
    ? input.server
    : action === 'read' ? '?' : 'all servers';
  const uri = typeof input.uri === 'string' ? input.uri : undefined;

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-cyan-400 shrink-0">{LABELS[action]}</span>
      <span className="font-mono text-blue-400 shrink-0">{server}</span>
      {uri && (
        <span className="font-mono text-slate-400 truncate" title={uri}>{uri}</span>
      )}
      {headerSuffix}
    </div>
  );
}

export function ListMcpResourcesToolView(props: {
  input: Record<string, unknown>;
  headerSuffix?: ReactNode;
}) {
  return <McpResourceToolView {...props} action="list" />;
}

export function ListMcpResourceTemplatesToolView(props: {
  input: Record<string, unknown>;
  headerSuffix?: ReactNode;
}) {
  return <McpResourceToolView {...props} action="list-templates" />;
}

export function ReadMcpResourceToolView(props: {
  input: Record<string, unknown>;
  headerSuffix?: ReactNode;
}) {
  return <McpResourceToolView {...props} action="read" />;
}
