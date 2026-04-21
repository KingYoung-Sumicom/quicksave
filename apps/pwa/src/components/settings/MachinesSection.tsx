import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { useNavigate } from 'react-router-dom';
import { useMachineStore, selectSortedMachines, type Machine } from '../../stores/machineStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { EditMachineModal } from '../EditMachineModal';
import { ConfirmModal } from '../ui/ConfirmModal';

export function MachinesSection() {
  const navigate = useNavigate();
  const machines = useMachineStore(selectSortedMachines);
  const removeMachine = useMachineStore((s) => s.removeMachine);
  const agentConnections = useConnectionStore((s) => s.agentConnections);

  const [editing, setEditing] = useState<Machine | null>(null);
  const [removing, setRemoving] = useState<Machine | null>(null);
  // Edit mode toggles the per-row delete/rename affordances; default taps
  // instead open the per-machine info page so destructive/edit actions can't
  // be hit by accident.
  const [editMode, setEditMode] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
          <FormattedMessage id="settings.machines.title" />
        </h3>
        {machines.length > 0 && (
          <button
            type="button"
            onClick={() => setEditMode((v) => !v)}
            className="text-xs font-medium text-slate-300 hover:text-white transition-colors"
          >
            {editMode ? (
              <FormattedMessage id="common.done" defaultMessage="Done" />
            ) : (
              <FormattedMessage id="common.edit" defaultMessage="Edit" />
            )}
          </button>
        )}
      </div>

      {machines.length === 0 ? (
        <p className="text-xs text-slate-500">
          <FormattedMessage id="settings.machines.empty" />
        </p>
      ) : (
        <div className="space-y-2">
          {machines.map((machine) => {
            const conn = agentConnections[machine.agentId];
            const isConnected = conn?.state === 'connected' && conn?.online !== false;
            const rowContent = (
              <>
                <div className="relative w-9 h-9 bg-slate-700 rounded-lg flex items-center justify-center text-lg flex-shrink-0">
                  {machine.icon}
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-800 ${
                      isConnected ? 'bg-green-500' : 'bg-slate-500'
                    }`}
                    aria-label={isConnected ? 'Online' : 'Offline'}
                  />
                </div>
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-sm font-medium text-white truncate">{machine.nickname}</p>
                  <p className="text-xs text-slate-400 font-mono truncate">
                    {machine.agentId.slice(0, 12)}…
                  </p>
                </div>
              </>
            );

            if (editMode) {
              return (
                <div
                  key={machine.agentId}
                  className="flex items-center gap-3 p-3 bg-slate-700/50 rounded-lg"
                >
                  {rowContent}
                  <button
                    onClick={() => setEditing(machine)}
                    className="p-2 text-slate-400 hover:text-white hover:bg-slate-600 rounded-md transition-colors"
                    aria-label="Edit machine"
                    title="Edit"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setRemoving(machine)}
                    className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-600 rounded-md transition-colors"
                    aria-label="Remove machine"
                    title="Remove"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              );
            }

            return (
              <button
                key={machine.agentId}
                type="button"
                onClick={() => navigate(`/settings/m/${machine.agentId}`)}
                className="w-full flex items-center gap-3 p-3 bg-slate-700/50 hover:bg-slate-700 rounded-lg transition-colors text-left"
              >
                {rowContent}
                <svg className="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            );
          })}
        </div>
      )}

      {editing && (
        <EditMachineModal machine={editing} onClose={() => setEditing(null)} />
      )}

      {removing && (
        <ConfirmModal
          title={<FormattedMessage id="settings.machines.remove.confirm.title" />}
          message={
            <FormattedMessage
              id="settings.machines.remove.confirm.message"
              values={{ nickname: removing.nickname }}
            />
          }
          confirmLabel={<FormattedMessage id="common.remove" />}
          confirmText={removing.nickname}
          variant="danger"
          onConfirm={() => {
            removeMachine(removing.agentId);
            setRemoving(null);
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
