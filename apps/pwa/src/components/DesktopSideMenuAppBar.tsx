import { BaseStatusBar, SettingsGearButton, PlusButton } from './BaseStatusBar';

interface DesktopSideMenuAppBarProps {
  onOpenSettings?: () => void;
  onOpenAddNew?: () => void;
}

export function DesktopSideMenuAppBar({ onOpenSettings, onOpenAddNew }: DesktopSideMenuAppBarProps) {
  return (
    <BaseStatusBar
      left={onOpenSettings && <SettingsGearButton onClick={onOpenSettings} />}
      center={<span className="text-sm font-medium text-slate-300">Quicksave</span>}
      right={onOpenAddNew && <PlusButton onClick={onOpenAddNew} />}
    />
  );
}
