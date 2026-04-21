import { useNavigate } from 'react-router-dom';
import { BaseStatusBar, MenuButton, BackButton } from './BaseStatusBar';

interface NewSessionAppBarProps {
  cwd?: string;
  onOpenMenu: () => void;
  /** When set, show back arrow navigating to this path instead of hamburger menu */
  backTo?: string;
}

export function NewSessionAppBar({ cwd, onOpenMenu, backTo }: NewSessionAppBarProps) {
  const navigate = useNavigate();
  const displayPath = cwd?.split('/').pop() || cwd || 'New Task';

  return (
    <BaseStatusBar
      left={backTo
        ? <BackButton onClick={() => navigate(-1)} />
        : <MenuButton onClick={onOpenMenu} />
      }
      center={
        <span className="text-sm font-medium text-slate-300 truncate" title={cwd}>
          {displayPath}
        </span>
      }
    />
  );
}
