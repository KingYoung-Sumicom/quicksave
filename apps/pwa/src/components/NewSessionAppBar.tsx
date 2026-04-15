import { BaseStatusBar, MenuButton } from './BaseStatusBar';

interface NewSessionAppBarProps {
  cwd?: string;
  onOpenMenu: () => void;
}

export function NewSessionAppBar({ cwd, onOpenMenu }: NewSessionAppBarProps) {
  const displayPath = cwd?.split('/').pop() || cwd || 'New Session';

  return (
    <BaseStatusBar
      left={<MenuButton onClick={onOpenMenu} />}
      center={
        <span className="text-sm font-medium text-slate-300 truncate" title={cwd}>
          {displayPath}
        </span>
      }
    />
  );
}
