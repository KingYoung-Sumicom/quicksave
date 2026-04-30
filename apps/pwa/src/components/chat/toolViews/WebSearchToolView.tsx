// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/** Codex's webSearch ThreadItem ships `query` empty at item/started — fixed
 *  in the agent now, but historical cards persisted before the fix still
 *  carry `{ query: "" }` and a result content like `Search: <real query>`.
 *  Fall back to that result text so legacy cards don't render as "Search ?". */
function extractQueryFromResult(result: string | undefined): string | null {
  if (!result) return null;
  const prefix = 'Search: ';
  return result.startsWith(prefix) ? result.slice(prefix.length).split('\n')[0] : null;
}

export function WebSearchToolView({ input, resultContent }: { input: Record<string, unknown>; resultContent?: string }) {
  const query = (input.query as string) || extractQueryFromResult(resultContent) || '?';

  return (
    <div>
      <span className="text-cyan-400">Search</span>{' '}
      <span className="text-slate-200">{query}</span>
    </div>
  );
}
