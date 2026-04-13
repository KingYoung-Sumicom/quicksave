import { useState, useRef } from 'react';
import { ErrorBox } from '../ui/ErrorBox';
import { exportMasterSecret, importMasterSecret, saveApiKey as saveApiKeyToStorage, getApiKey } from '../../lib/secureStorage';
import { useMachineStore } from '../../stores/machineStore';
import type { Machine } from '../../stores/machineStore';

interface BackupData {
  masterSecret: string;
  apiKey?: string;
  machines?: Machine[];
}

export function PrimaryKeySection() {
  const [copyLabel, setCopyLabel] = useState('Copy to Clipboard');
  const [pastedKey, setPastedKey] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingBackup, setPendingBackup] = useState<BackupData | null>(null);

  async function handleCopySecret(): Promise<void> {
    try {
      const secret = await exportMasterSecret();
      await navigator.clipboard.writeText(secret);
      setCopyLabel('Copied!');
      setTimeout(() => setCopyLabel('Copy to Clipboard'), 2000);
    } catch {
      setCopyLabel('Failed to copy');
      setTimeout(() => setCopyLabel('Copy to Clipboard'), 2000);
    }
  }

  async function handleDownloadSecret(): Promise<void> {
    try {
      const masterSecret = await exportMasterSecret();
      const apiKeyValue = await getApiKey();
      const machines = useMachineStore.getState().machines;
      const backup: Record<string, unknown> = {
        version: 2,
        masterSecret,
        exportedAt: new Date().toISOString(),
      };
      if (apiKeyValue) {
        backup.apiKey = apiKeyValue;
      }
      if (machines.length > 0) {
        backup.machines = machines.map(({ isPro: _, ...rest }) => rest);
      }
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().split('T')[0];
      const a = document.createElement('a');
      a.href = url;
      a.download = `quicksave-key-backup-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setImportError('Failed to export key');
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        const secret = parsed.masterSecret;
        if (!secret || typeof secret !== 'string') {
          setImportError('Invalid backup file: missing masterSecret field');
          return;
        }
        setPendingBackup({
          masterSecret: secret,
          apiKey: parsed.apiKey,
          machines: parsed.machines,
        });
      } catch {
        setImportError('Invalid backup file: could not parse JSON');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handlePasteRestore(): void {
    if (!pastedKey.trim()) {
      setImportError('Please paste a key first');
      return;
    }
    setPendingBackup({ masterSecret: pastedKey.trim() });
  }

  async function handleConfirmImport(): Promise<void> {
    if (!pendingBackup) return;

    try {
      await importMasterSecret(pendingBackup.masterSecret);

      if (pendingBackup.apiKey) {
        await saveApiKeyToStorage(pendingBackup.apiKey);
      }

      if (pendingBackup.machines && pendingBackup.machines.length > 0) {
        const { addMachine } = useMachineStore.getState();
        for (const machine of pendingBackup.machines) {
          if (!useMachineStore.getState().hasMachine(machine.agentId)) {
            addMachine({
              agentId: machine.agentId,
              publicKey: machine.publicKey,
              nickname: machine.nickname,
              icon: machine.icon,
            });
          }
        }
      }

      setImportSuccess(true);
      setImportError(null);
      setPastedKey('');
      setPendingBackup(null);
      setTimeout(() => setImportSuccess(false), 3000);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import backup');
      setPendingBackup(null);
    }
  }

  return (
    <>
      <div className="space-y-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
          Primary Key
        </h3>

        <p className="text-sm text-slate-400">
          Your primary key encrypts all connections. Back it up to restore access on a new device.
        </p>

        {/* Export */}
        <div className="flex gap-2">
          <button
            onClick={handleCopySecret}
            className="flex-1 py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-white transition-colors"
          >
            {copyLabel}
          </button>
          <button
            onClick={handleDownloadSecret}
            className="flex-1 py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-white transition-colors"
          >
            Download File
          </button>
        </div>

        {/* Import */}
        <div className="space-y-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-white transition-colors"
          >
            Restore from File
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileSelect}
            className="hidden"
          />

          <div className="space-y-2">
            <label className="block text-sm text-slate-400">
              Or paste key:
            </label>
            <textarea
              value={pastedKey}
              onChange={(e) => setPastedKey(e.target.value)}
              placeholder="Paste your backup key here..."
              rows={3}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none font-mono text-sm"
            />
            <button
              onClick={handlePasteRestore}
              disabled={!pastedKey.trim()}
              className="w-full py-2 px-3 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md text-sm font-medium text-white transition-colors"
            >
              Restore
            </button>
          </div>
        </div>

        {importError && (
          <ErrorBox>{importError}</ErrorBox>
        )}

        {importSuccess && (
          <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
            Primary key restored successfully!
          </div>
        )}
      </div>

      {/* Confirmation Dialog */}
      {pendingBackup !== null && (
        <>
          <div className="fixed inset-0 bg-black/50 z-[60]" />
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div className="bg-slate-800 rounded-lg w-full max-w-sm shadow-xl border border-slate-700">
              <div className="p-4 space-y-4">
                <h3 className="text-lg font-semibold text-white">
                  Restore Backup?
                </h3>
                <p className="text-sm text-slate-400">
                  This will replace your current primary key.
                  {pendingBackup.apiKey && ' Your API key will also be updated.'}
                  {pendingBackup.machines && pendingBackup.machines.length > 0 &&
                    ` ${pendingBackup.machines.length} machine(s) will be added.`}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPendingBackup(null)}
                    className="flex-1 py-2 px-4 bg-slate-700 hover:bg-slate-600 rounded-md font-medium text-white transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirmImport}
                    className="flex-1 py-2 px-4 bg-red-600 hover:bg-red-700 rounded-md font-medium text-white transition-colors"
                  >
                    Restore
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
