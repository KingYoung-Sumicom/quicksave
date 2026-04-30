// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
export function SystemMessage({ content }: { content: string }) {
  return (
    <div className="text-center text-xs text-slate-500 py-1">
      {content}
    </div>
  );
}
