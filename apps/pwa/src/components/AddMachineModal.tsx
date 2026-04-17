import { useState } from 'react';
import { useMachineStore } from '../stores/machineStore';
import { useConnectionStore } from '../stores/connectionStore';
import { QRScanner } from './QRScanner';
import { Modal } from './ui/Modal';
import { ErrorBox } from './ui/ErrorBox';

interface AddMachineModalProps {
  onClose: () => void;
  onConnect: (agentId: string, publicKey: string) => void;
}

const MACHINE_ICONS = ['💻', '🖥️', '💼', '🏠', '🏢', '🔧', '⚡', '🚀'];

export function AddMachineModal({ onClose, onConnect }: AddMachineModalProps) {
  const [agentId, setAgentId] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [signPublicKey, setSignPublicKey] = useState<string | undefined>(undefined);
  const [nickname, setNickname] = useState('');
  const [icon, setIcon] = useState('💻');
  const [mode, setMode] = useState<'scan' | 'manual'>('manual');
  const [saveOnly, setSaveOnly] = useState(false);

  const { addMachine, hasMachine } = useMachineStore();
  const { state, error } = useConnectionStore();

  const handleQRScan = (scannedAgentId: string, scannedPublicKey: string, name?: string, scannedSignPk?: string) => {
    setAgentId(scannedAgentId);
    setPublicKey(scannedPublicKey);
    setSignPublicKey(scannedSignPk);
    if (name && !nickname) {
      setNickname(name);
    }
    setMode('manual');
  };

  const isConnecting = state === 'connecting';
  const isDuplicate = Boolean(agentId.trim() && hasMachine(agentId.trim()));
  const isFormValid = Boolean(agentId.trim() && publicKey.trim());
  const isDisabled = !isFormValid || isConnecting || isDuplicate;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId.trim() || !publicKey.trim()) return;
    if (isDuplicate) return;

    const machineName = nickname.trim() || `Machine ${agentId.slice(0, 8)}`;

    // Always save the machine
    addMachine({
      agentId: agentId.trim(),
      publicKey: publicKey.trim(),
      signPublicKey: signPublicKey?.trim() || undefined,
      nickname: machineName,
      icon,
    });

    if (saveOnly) {
      onClose();
    } else {
      // Connect to the new machine
      onConnect(agentId.trim(), publicKey.trim());
    }
  };

  return (
    <Modal title="Add Machine" onClose={onClose}>
      <div className="p-4">
          {/* Mode Toggle */}
          <div className="flex mb-6 bg-slate-700 rounded-lg p-1">
            <button
              type="button"
              className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                mode === 'manual'
                  ? 'bg-slate-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
              onClick={() => setMode('manual')}
            >
              Manual Entry
            </button>
            <button
              type="button"
              className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                mode === 'scan'
                  ? 'bg-slate-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
              onClick={() => setMode('scan')}
            >
              Scan QR
            </button>
          </div>

          {mode === 'manual' ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Agent ID */}
              <div>
                <label htmlFor="agentId" className="block text-sm font-medium text-slate-300 mb-1">
                  Agent ID
                </label>
                <input
                  id="agentId"
                  type="text"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  placeholder="Enter agent ID"
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  disabled={isConnecting}
                />
                {isDuplicate && (
                  <p className="text-sm text-yellow-400 mt-1">
                    This machine is already in your list
                  </p>
                )}
              </div>

              {/* Public Key */}
              <div>
                <label htmlFor="publicKey" className="block text-sm font-medium text-slate-300 mb-1">
                  Public Key
                </label>
                <textarea
                  id="publicKey"
                  value={publicKey}
                  onChange={(e) => setPublicKey(e.target.value)}
                  placeholder="Enter agent public key"
                  rows={3}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none font-mono text-sm"
                  disabled={isConnecting}
                />
              </div>

              {/* Nickname */}
              <div>
                <label htmlFor="nickname" className="block text-sm font-medium text-slate-300 mb-1">
                  Nickname <span className="text-slate-500">(optional)</span>
                </label>
                <input
                  id="nickname"
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="e.g., Work Laptop, Home Desktop"
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  disabled={isConnecting}
                />
              </div>

              {/* Icon Selector */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Icon
                </label>
                <div className="flex gap-2 flex-wrap">
                  {MACHINE_ICONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setIcon(emoji)}
                      className={`w-10 h-10 rounded-md text-xl flex items-center justify-center transition-colors ${
                        icon === emoji
                          ? 'bg-blue-600'
                          : 'bg-slate-700 hover:bg-slate-600'
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Error */}
              {error && (
                <ErrorBox className="p-3">{error}</ErrorBox>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  disabled={isDisabled}
                  onClick={() => setSaveOnly(false)}
                  className="flex-1 py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors"
                >
                  {isConnecting ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="loading-dot w-2 h-2 bg-white rounded-full" />
                      <span className="loading-dot w-2 h-2 bg-white rounded-full" />
                      <span className="loading-dot w-2 h-2 bg-white rounded-full" />
                    </span>
                  ) : (
                    'Add & Connect'
                  )}
                </button>
                <button
                  type="submit"
                  disabled={isDisabled}
                  onClick={() => setSaveOnly(true)}
                  className="py-3 px-4 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors"
                >
                  Save
                </button>
              </div>
            </form>
          ) : (
            <div className="py-4">
              <QRScanner onScan={handleQRScan} />
            </div>
          )}
        </div>
    </Modal>
  );
}
