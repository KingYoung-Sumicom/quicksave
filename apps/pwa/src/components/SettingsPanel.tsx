import { useState, useRef, useEffect } from 'react';
import { SwipeableDrawer } from './SwipeableDrawer';
import { exportMasterSecret, importMasterSecret, saveApiKey as saveApiKeyToStorage, hasApiKey, getApiKey } from '../lib/secureStorage';
import { useMachineStore } from '../stores/machineStore';
import type { Machine } from '../stores/machineStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useGitStore } from '../stores/gitStore';
import { DevicePairingSection } from './DevicePairingSection';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSendApiKeyToAgent?: (apiKey: string) => Promise<boolean>;
  onCheckAgentUpdate?: () => Promise<{ currentVersion: string; latestVersion?: string; updateAvailable: boolean; error?: string }>;
  onUpdateAgent?: () => Promise<{ success: boolean; previousVersion: string; newVersion?: string; restarting: boolean; error?: string }>;
}

export function SettingsPanel({ isOpen, onClose, onSendApiKeyToAgent, onCheckAgentUpdate, onUpdateAgent }: SettingsPanelProps) {
  // Agent update state
  const agentVersion = useConnectionStore((s) => s.agentVersion);
  const latestVersionFromStore = useConnectionStore((s) => s.latestVersion);
  const devBuild = useConnectionStore((s) => s.devBuild);
  const setLatestVersionInStore = useConnectionStore((s) => s.setLatestVersion);
  const connectionState = useConnectionStore((s) => s.state);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ success: boolean; message: string } | null>(null);

  // Reset result when panel closes
  useEffect(() => {
    if (!isOpen) setUpdateResult(null);
  }, [isOpen]);

  // API Key state
  const [apiKey, setApiKey] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keySuccess, setKeySuccess] = useState(false);
  const [apiKeyStored, setApiKeyStored] = useState(false);
  const [showApiKeyHelp, setShowApiKeyHelp] = useState(false);

  // Export state
  const [copyLabel, setCopyLabel] = useState('Copy to Clipboard');

  // Import state
  const [pastedKey, setPastedKey] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Confirmation dialog state
  interface BackupData {
    masterSecret: string;
    apiKey?: string;
    machines?: Machine[];
  }
  const [pendingBackup, setPendingBackup] = useState<BackupData | null>(null);

  // Check if API key is stored locally when panel opens
  useEffect(() => {
    if (isOpen) {
      hasApiKey().then((stored) => {
        setApiKeyStored(stored);
        if (!stored) setShowApiKeyHelp(true);
      });
    }
  }, [isOpen]);

  async function handleSaveApiKey(): Promise<void> {
    if (!apiKey.trim()) {
      setKeyError('Please enter an API key');
      return;
    }

    setIsSavingKey(true);
    setKeyError(null);
    setKeySuccess(false);

    try {
      // Always save locally
      await saveApiKeyToStorage(apiKey.trim());
      setApiKeyStored(true);

      // Also send to agent if connected
      if (onSendApiKeyToAgent) {
        await onSendApiKeyToAgent(apiKey.trim());
      }

      setKeySuccess(true);
      setApiKey('');
      setTimeout(() => setKeySuccess(false), 2000);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setIsSavingKey(false);
    }
  }

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

    // Reset the file input so the same file can be selected again
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

      // Restore API key if present
      if (pendingBackup.apiKey) {
        await saveApiKeyToStorage(pendingBackup.apiKey);
        setApiKeyStored(true);
      }

      // Restore machines if present
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
    <SwipeableDrawer isOpen={isOpen} onClose={onClose} side="right" drawerWidth={400} className="w-[90%] max-w-[400px] bg-slate-800 flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-700 rounded-md transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">

          {/* Section 1: API Key */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Anthropic API Key
            </h3>

            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-300">
                Required for AI commit summaries
              </p>
              {apiKeyStored && (
                <span className="text-xs text-green-400 flex items-center gap-1">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Configured
                </span>
              )}
            </div>

            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={apiKeyStored ? 'Enter new key to update...' : 'sk-ant-...'}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              disabled={isSavingKey}
            />

            <p className="text-xs text-slate-400">
              Your API key is stored on your device and sent securely to your machines when connected.
            </p>

            {keyError && (
              <div className="p-2 bg-red-500/20 border border-red-500/50 rounded text-sm text-red-400">
                {keyError}
              </div>
            )}

            {keySuccess && (
              <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
                API key saved successfully!
              </div>
            )}

            <button
              onClick={handleSaveApiKey}
              disabled={isSavingKey || !apiKey.trim()}
              className="w-full py-2 px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2"
            >
              {isSavingKey ? (
                <>
                  <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Saving...
                </>
              ) : (
                'Save API Key'
              )}
            </button>

            <button
              type="button"
              onClick={() => setShowApiKeyHelp(!showApiKeyHelp)}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-300 transition-colors"
            >
              <svg
                className={`w-3 h-3 transition-transform ${showApiKeyHelp ? 'rotate-90' : ''}`}
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                  clipRule="evenodd"
                />
              </svg>
              How to get an API key
            </button>

            {showApiKeyHelp && (
              <div className="space-y-3">
                {/* Explanation */}
                <div className="p-3 bg-slate-700/50 rounded-lg text-sm text-slate-300 space-y-2">
                  <p className="font-medium">Why is an API key required?</p>
                  <p className="text-slate-400">
                    Quicksave uses Claude AI to generate commit message summaries from your diffs.
                    Claude Pro/Max subscriptions only work with the official Claude apps.
                    Third-party tools like quicksave require a separate API key with usage-based billing.
                  </p>
                </div>

                {/* How to get API Key */}
                <div className="p-3 bg-slate-700/50 rounded-lg text-sm space-y-3">
                  <p className="font-medium text-slate-300">How to get your API key:</p>
                  <ol className="list-decimal list-inside space-y-1.5 text-slate-400">
                    <li>
                      Go to{' '}
                      <a
                        href="https://console.anthropic.com/settings/keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-purple-400 hover:text-purple-300 underline"
                      >
                        console.anthropic.com/settings/keys
                      </a>
                    </li>
                    <li>Sign in or create an Anthropic account</li>
                    <li>Click &quot;Create Key&quot; and give it a name</li>
                    <li>Copy the key (starts with sk-ant-...)</li>
                    <li>Paste it above and click Save</li>
                  </ol>
                </div>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-slate-700" />

          {/* Section 2: Primary Key */}
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
              <div className="p-2 bg-red-500/20 border border-red-500/50 rounded text-sm text-red-400">
                {importError}
              </div>
            )}

            {importSuccess && (
              <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
                Primary key restored successfully!
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-slate-700" />

          {/* Section 3: Device Sync */}
          <DevicePairingSection />

          {/* Section 4: Git Attribution */}
          <div className="border-t border-slate-700" />
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Git
            </h3>
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <span className="text-sm text-white">Commit attribution</span>
                <p className="text-xs text-slate-400 mt-0.5">Add Quicksave trailer to commit messages</p>
              </div>
              <AttributionToggle />
            </label>
          </div>

          {/* Section 5: Agent Version & Update — only when connected */}
          {connectionState === 'connected' && (
            <>
              <div className="border-t border-slate-700" />

              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                  CLI Agent
                </h3>

                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-300">Version</p>
                  <span className="text-sm font-mono text-slate-400">
                    {agentVersion || 'unknown'}{devBuild ? ' (dev)' : ''}
                  </span>
                </div>

                {devBuild ? (
                  <div className="p-2 bg-slate-700/50 rounded text-sm text-slate-500">
                    Update not available for dev builds
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-slate-300">Latest</p>
                      <span className="text-sm font-mono text-slate-400 flex items-center gap-2">
                        {isCheckingUpdate ? (
                          <span className="inline-block w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                        ) : (
                          latestVersionFromStore || '—'
                        )}
                        {onCheckAgentUpdate && !isCheckingUpdate && (
                          <button
                            onClick={async () => {
                              setIsCheckingUpdate(true);
                              try {
                                const result = await onCheckAgentUpdate();
                                if (result.latestVersion) setLatestVersionInStore(result.latestVersion);
                              } finally {
                                setIsCheckingUpdate(false);
                              }
                            }}
                            className="p-0.5 hover:bg-slate-600 rounded transition-colors"
                            aria-label="Check for updates"
                            title="Check for updates"
                          >
                            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          </button>
                        )}
                      </span>
                    </div>

                    {latestVersionFromStore && agentVersion && latestVersionFromStore !== agentVersion && (
                      <div className="p-2 bg-amber-500/20 border border-amber-500/50 rounded text-sm text-amber-400">
                        New version available: {latestVersionFromStore}
                      </div>
                    )}

                    {latestVersionFromStore && agentVersion && latestVersionFromStore === agentVersion && !updateResult && (
                      <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
                        Already up to date
                      </div>
                    )}

                    {updateResult && (
                      <div className={`p-2 rounded text-sm ${
                        updateResult.success
                          ? 'bg-green-500/20 border border-green-500/50 text-green-400'
                          : 'bg-red-500/20 border border-red-500/50 text-red-400'
                      }`}>
                        {updateResult.message}
                      </div>
                    )}

                    <button
                      onClick={async () => {
                        if (!onUpdateAgent) return;
                        setIsUpdating(true);
                        setUpdateResult(null);
                        try {
                          const result = await onUpdateAgent();
                          if (result.success) {
                            const msg = result.restarting
                              ? `Updated: ${result.previousVersion} → ${result.newVersion}. Agent is restarting...`
                              : `Already on the latest version (${result.previousVersion}).`;
                            setUpdateResult({ success: true, message: msg });
                            if (result.newVersion) setLatestVersionInStore(result.newVersion);
                          } else {
                            setUpdateResult({ success: false, message: result.error || 'Update failed' });
                          }
                        } catch (err) {
                          setUpdateResult({ success: false, message: err instanceof Error ? err.message : 'Update failed' });
                        } finally {
                          setIsUpdating(false);
                        }
                      }}
                      disabled={isUpdating || !onUpdateAgent || (!!latestVersionFromStore && latestVersionFromStore === agentVersion)}
                      className="w-full py-2 px-4 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2"
                    >
                      {isUpdating ? (
                        <>
                          <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          Updating...
                        </>
                      ) : (
                        'Update Agent'
                      )}
                    </button>
                  </>
                )}
              </div>
            </>
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
    </SwipeableDrawer>
  );
}

function AttributionToggle() {
  const enabled = useGitStore((s) => s.attributionEnabled);
  const setEnabled = useGitStore((s) => s.setAttributionEnabled);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => setEnabled(!enabled)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200 ease-in-out ${enabled ? 'bg-purple-600' : 'bg-slate-600'}`}
    >
      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out mt-0.5 ${enabled ? 'translate-x-5 ml-0.5' : 'translate-x-0 ml-0.5'}`} />
    </button>
  );
}
