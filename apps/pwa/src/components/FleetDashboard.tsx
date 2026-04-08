import { useState } from 'react';
import { useMachineStore, selectSortedMachines } from '../stores/machineStore';
import { MachineCard } from './MachineCard';
import { AddMachineModal } from './AddMachineModal';
import { EditMachineModal } from './EditMachineModal';
import { SettingsPanel } from './SettingsPanel';
import type { Machine } from '../stores/machineStore';

interface FleetDashboardProps {
  onNavigate: (agentId: string) => void;
  onConnect: (agentId: string, publicKey: string) => void;
  onSendApiKeyToAgent?: (apiKey: string) => Promise<boolean>;
  showSettings?: boolean;
  onCloseSettings?: () => void;
}

export function FleetDashboard({ onNavigate, onConnect, onSendApiKeyToAgent, showSettings = false, onCloseSettings }: FleetDashboardProps) {
  const machines = useMachineStore(selectSortedMachines);
  const { removeMachine } = useMachineStore();

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingMachine, setEditingMachine] = useState<Machine | null>(null);

  const handleRemove = (machine: Machine) => {
    if (confirm(`Remove "${machine.nickname}" from your machines?`)) {
      removeMachine(machine.agentId);
    }
  };

  return (
    <div className="min-h-screen flex flex-col safe-area-top safe-area-bottom">
      <div className="w-full max-w-lg mx-auto px-4 py-6 flex flex-col flex-1">
      {/* All Machines */}
      <section className="flex-1 mt-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">
            Machines
          </h2>
          <button
            onClick={() => setShowAddModal(true)}
            className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            + Add Machine
          </button>
        </div>

        {machines.length === 0 ? (
          <EmptyState onAddMachine={() => setShowAddModal(true)} />
        ) : (
          <div className="space-y-2">
            {machines.map((machine) => (
              <MachineCard
                key={machine.agentId}
                machine={machine}
                onConnect={() => onNavigate(machine.agentId)}
                onEdit={() => setEditingMachine(machine)}
                onRemove={() => handleRemove(machine)}
                variant="compact"
              />
            ))}
          </div>
        )}
      </section>

      {/* Help Text */}
      <div className="mt-6 text-center">
        <p className="text-sm text-slate-500">
          Run <code className="text-slate-400">quicksave-agent</code> on your computer, then tap <strong className="text-slate-400">+ Add Machine</strong> to pair.
        </p>
      </div>

      {/* Add Machine Modal */}
      {showAddModal && (
        <AddMachineModal
          onClose={() => setShowAddModal(false)}
          onConnect={onConnect}
        />
      )}

      {/* Edit Machine Modal */}
      {editingMachine && (
        <EditMachineModal
          machine={editingMachine}
          onClose={() => setEditingMachine(null)}
        />
      )}

      {/* Settings Panel */}
      <SettingsPanel
        isOpen={showSettings}
        onClose={onCloseSettings ?? (() => {})}
        onSendApiKeyToAgent={onSendApiKeyToAgent}
      />
      </div>
    </div>
  );
}

function EmptyState({ onAddMachine }: { onAddMachine: () => void }) {
  return (
    <div className="text-center py-12">
      <div className="w-16 h-16 mx-auto bg-slate-800 rounded-full flex items-center justify-center mb-4">
        <svg className="w-8 h-8 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
          />
        </svg>
      </div>
      <h3 className="text-lg font-medium text-white mb-2">No machines yet</h3>
      <p className="text-slate-400 text-sm mb-4">
        Add your first machine to get started
      </p>
      <button
        onClick={onAddMachine}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-md text-sm font-medium transition-colors"
      >
        Add Machine
      </button>
    </div>
  );
}
