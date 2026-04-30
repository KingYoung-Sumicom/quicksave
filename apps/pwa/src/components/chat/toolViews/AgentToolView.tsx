// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
export function AgentToolView({ input }: { input: Record<string, unknown> }) {
  const description = (input.description as string) || '';
  const subagentType = (input.subagent_type as string) || 'general-purpose';

  return (
    <div>
      <span className="text-violet-400">Agent</span>{' '}
      <span className="text-slate-300 font-mono">{subagentType}</span>
      {description && (
        <div className="mt-1 text-slate-400 truncate">{description}</div>
      )}
    </div>
  );
}
