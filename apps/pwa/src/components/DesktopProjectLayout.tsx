// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { Outlet } from 'react-router-dom';
import { ProjectList } from './ProjectList';

interface DesktopProjectLayoutProps {
  onOpenSettings?: () => void;
  onAddMachine?: () => void;
}

export function DesktopProjectLayout({ onOpenSettings, onAddMachine }: DesktopProjectLayoutProps) {
  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar: project list */}
      <div className="w-72 shrink-0 border-r border-slate-700 bg-slate-800/50">
        <ProjectList compact onOpenSettings={onOpenSettings} onAddMachine={onAddMachine} />
      </div>

      {/* Right: active content */}
      <div className="flex-1 min-w-0 flex flex-col">
        <Outlet />
      </div>
    </div>
  );
}
