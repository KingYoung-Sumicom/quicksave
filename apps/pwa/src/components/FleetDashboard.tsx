import { useState } from 'react';
import { useMachineStore, selectSortedMachines, selectRecentMachines } from '../stores/machineStore';
import { useConnectionStore } from '../stores/connectionStore';
import { MachineCard } from './MachineCard';
import { AddMachineModal } from './AddMachineModal';
import { EditMachineModal } from './EditMachineModal';
import type { Machine } from '../stores/machineStore';

interface FleetDashboardProps {
  onConnect: (agentId: string, publicKey: string) => void;
}

export function FleetDashboard({ onConnect }: FleetDashboardProps) {
  const machines = useMachineStore(selectSortedMachines);
  const recentMachines = useMachineStore(selectRecentMachines(3));
  const { removeMachine } = useMachineStore();
  const { state } = useConnectionStore();

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingMachine, setEditingMachine] = useState<Machine | null>(null);
  const [connectingAgentId, setConnectingAgentId] = useState<string | null>(null);

  const isConnecting = state === 'connecting' || state === 'signaling';

  const handleConnect = (machine: Machine) => {
    setConnectingAgentId(machine.agentId);
    onConnect(machine.agentId, machine.publicKey);
  };

  const handleRemove = (machine: Machine) => {
    if (confirm(`Remove "${machine.nickname}" from your machines?`)) {
      removeMachine(machine.agentId);
    }
  };

  // Filter out recent machines from the full list to avoid duplicates
  const recentIds = new Set(recentMachines.map((m) => m.agentId));
  const otherMachines = machines.filter((m) => !recentIds.has(m.agentId));

  return (
    <div className="min-h-screen flex flex-col p-6 safe-area-top safe-area-bottom">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Quicksave</h1>
        <p className="text-slate-400">Select a machine to connect</p>
      </div>

      {/* Recent Machines - Quick Access */}
      {recentMachines.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-medium text-slate-400 mb-3 uppercase tracking-wide">
            Recent
          </h2>
          <div className="space-y-2">
            {recentMachines.map((machine) => (
              <MachineCard
                key={machine.agentId}
                machine={machine}
                onConnect={() => handleConnect(machine)}
                variant="compact"
                isConnecting={isConnecting && connectingAgentId === machine.agentId}
              />
            ))}
          </div>
        </section>
      )}

      {/* All Machines */}
      <section className="flex-1">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">
            {recentMachines.length > 0 ? 'Other Machines' : 'All Machines'}
          </h2>
          <button
            onClick={() => setShowAddModal(true)}
            className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            + Add Machine
          </button>
        </div>

        {otherMachines.length === 0 && recentMachines.length === 0 ? (
          <EmptyState onAddMachine={() => setShowAddModal(true)} />
        ) : otherMachines.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-4">
            No other machines
          </p>
        ) : (
          <div className="space-y-2">
            {otherMachines.map((machine) => (
              <MachineCard
                key={machine.agentId}
                machine={machine}
                onConnect={() => handleConnect(machine)}
                onEdit={() => setEditingMachine(machine)}
                onRemove={() => handleRemove(machine)}
                variant="full"
                isConnecting={isConnecting && connectingAgentId === machine.agentId}
              />
            ))}
          </div>
        )}
      </section>

      {/* Help Text */}
      <div className="mt-6 text-center">
        <p className="text-sm text-slate-500">
          Run <code className="text-slate-400">quicksave-agent</code> on your computer to add a new machine.
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
