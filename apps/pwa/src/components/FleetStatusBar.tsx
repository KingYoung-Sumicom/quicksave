import { BaseStatusBar, SettingsGearButton } from './BaseStatusBar';

interface FleetStatusBarProps {
  title: string;
  onOpenSettings: () => void;
}

export function FleetStatusBar({ title, onOpenSettings }: FleetStatusBarProps) {
  return (
    <BaseStatusBar
      center={<span className="text-sm font-medium text-slate-300 truncate">{title}</span>}
      right={<SettingsGearButton onClick={onOpenSettings} />}
    />
  );
}
