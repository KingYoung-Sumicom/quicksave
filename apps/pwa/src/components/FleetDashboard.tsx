import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMachineStore, selectSortedMachines, selectRecentMachines } from '../stores/machineStore';
import { MachineCard } from './MachineCard';
import { AddMachineModal } from './AddMachineModal';
import { EditMachineModal } from './EditMachineModal';
import { SettingsPanel } from './SettingsPanel';
import type { Machine } from '../stores/machineStore';

interface FleetDashboardProps {
  onConnect: (agentId: string, publicKey: string) => void;
  onSendApiKeyToAgent?: (apiKey: string) => Promise<boolean>;
}

export function FleetDashboard({ onConnect, onSendApiKeyToAgent }: FleetDashboardProps) {
  const navigate = useNavigate();
  const machines = useMachineStore(selectSortedMachines);
  const recentMachines = useMachineStore(selectRecentMachines(3));
  const { removeMachine } = useMachineStore();

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingMachine, setEditingMachine] = useState<Machine | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const handleConnect = (machine: Machine, repoPath?: string) => {
    // Navigate to connecting page immediately - connection will be initiated there
    // Include repo path in URL if specified
    const url = repoPath
      ? `/connect/${machine.agentId}?repo=${encodeURIComponent(repoPath)}`
      : `/connect/${machine.agentId}`;
    navigate(url);
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
      <div className="text-center mb-8 relative">
        <button
          onClick={() => setShowSettings(true)}
          className="absolute right-0 top-0 p-2 text-slate-400 hover:text-white transition-colors"
          aria-label="Settings"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
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
                onConnect={(repoPath) => handleConnect(machine, repoPath)}
                onEdit={() => setEditingMachine(machine)}
                onRemove={() => handleRemove(machine)}
                variant="compact"
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
                onConnect={(repoPath) => handleConnect(machine, repoPath)}
                onEdit={() => setEditingMachine(machine)}
                onRemove={() => handleRemove(machine)}
                variant="full"
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

      {/* Settings Panel */}
      <SettingsPanel
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        onSendApiKeyToAgent={onSendApiKeyToAgent}
      />
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
