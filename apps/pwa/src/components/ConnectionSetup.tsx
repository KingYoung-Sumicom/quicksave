import { useState, useEffect } from 'react';
import { useConnectionStore } from '../stores/connectionStore';
import { useMachineStore } from '../stores/machineStore';
import { QRScanner } from './QRScanner';

interface Props {
  onConnect: (agentId: string, publicKey: string) => void;
}

export function ConnectionSetup({ onConnect }: Props) {
  const [agentId, setAgentId] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [mode, setMode] = useState<'scan' | 'manual'>('scan');
  const { state, error } = useConnectionStore();
  const { addMachine } = useMachineStore();

  // Parse URL parameters on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const pk = params.get('pk');

    if (id && pk) {
      setAgentId(id);
      setPublicKey(pk);
      // Save machine and auto-connect
      addMachine({
        agentId: id,
        publicKey: pk,
        nickname: `Machine ${id.slice(0, 8)}`,
        icon: '💻',
      });
      onConnect(id, pk);
      // Clear URL params
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [onConnect, addMachine]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (agentId.trim() && publicKey.trim()) {
      // Save machine before connecting
      addMachine({
        agentId: agentId.trim(),
        publicKey: publicKey.trim(),
        nickname: `Machine ${agentId.trim().slice(0, 8)}`,
        icon: '💻',
      });
      onConnect(agentId.trim(), publicKey.trim());
    }
  };

  const isConnecting = state === 'connecting' || state === 'signaling';

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 safe-area-top safe-area-bottom">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Quicksave</h1>
          <p className="text-slate-400">Remote git control with E2E encryption</p>
        </div>

        {/* Connection Form */}
        <div className="bg-slate-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">Connect to Agent</h2>

          {/* Mode Toggle */}
          <div className="flex mb-6 bg-slate-700 rounded-lg p-1">
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
          </div>

          {mode === 'manual' ? (
            <form onSubmit={handleSubmit} className="space-y-4">
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
              </div>

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

              {error && (
                <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-md">
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={!agentId.trim() || !publicKey.trim() || isConnecting}
                className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors"
              >
                {isConnecting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="loading-dot w-2 h-2 bg-white rounded-full" />
                    <span className="loading-dot w-2 h-2 bg-white rounded-full" />
                    <span className="loading-dot w-2 h-2 bg-white rounded-full" />
                  </span>
                ) : (
                  'Connect'
                )}
              </button>
            </form>
          ) : (
            <div className="py-4">
              <QRScanner
                onScan={(id, pk) => {
                  // Save machine and connect
                  addMachine({
                    agentId: id,
                    publicKey: pk,
                    nickname: `Machine ${id.slice(0, 8)}`,
                    icon: '💻',
                  });
                  onConnect(id, pk);
                }}
              />
              {error && (
                <div className="mt-4 p-3 bg-red-500/20 border border-red-500/50 rounded-md">
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Help Text */}
        <div className="mt-6 text-center">
          <p className="text-sm text-slate-500">
            Run <code className="text-slate-400">quicksave-agent</code> on your computer to get connection details.
          </p>
        </div>
      </div>
    </div>
  );
}
