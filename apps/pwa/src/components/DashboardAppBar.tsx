import { BaseStatusBar, MenuButton } from './BaseStatusBar';
import { useConnectionStore } from '../stores/connectionStore';
import { useMachineStore } from '../stores/machineStore';

interface DashboardAppBarProps {
  editing: boolean;
  onToggleEdit: () => void;
  onOpenMenu: () => void;
}

export function DashboardAppBar({ editing, onToggleEdit, onOpenMenu }: DashboardAppBarProps) {
  const agentId = useConnectionStore((s) => s.agentId);
  const machine = useMachineStore((s) => agentId ? s.getMachine(agentId) : undefined);
  const title = machine?.nickname || 'Quicksave';

  return (
    <BaseStatusBar
      left={<MenuButton onClick={onOpenMenu} />}
      center={
        <span className="text-sm font-medium text-slate-300 truncate">{title}</span>
      }
      right={
        <button
          onClick={onToggleEdit}
          className={`p-1.5 rounded-md transition-colors ${
            editing
              ? 'text-blue-400 bg-slate-700'
              : 'text-slate-400 hover:bg-slate-700'
          }`}
          aria-label={editing ? 'Done editing' : 'Edit'}
          title={editing ? 'Done' : 'Edit'}
        >
          {editing ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
            </svg>
          )}
        </button>
      }
    />
  );
}
