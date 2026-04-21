import { useState, useRef } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { ErrorBox } from '../ui/ErrorBox';
import { ConfirmModal } from '../ui/ConfirmModal';
import { exportMasterSecret, importMasterSecret, saveApiKey as saveApiKeyToStorage, getApiKey } from '../../lib/secureStorage';
import { useMachineStore } from '../../stores/machineStore';
import type { Machine } from '../../stores/machineStore';

interface BackupData {
  masterSecret: string;
  apiKey?: string;
  machines?: Machine[];
}

type CopyState = 'idle' | 'copied' | 'failed';

export function PrimaryKeySection() {
  const intl = useIntl();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [pastedKey, setPastedKey] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingBackup, setPendingBackup] = useState<BackupData | null>(null);

  async function handleCopySecret(): Promise<void> {
    try {
      const secret = await exportMasterSecret();
      await navigator.clipboard.writeText(secret);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('failed');
      setTimeout(() => setCopyState('idle'), 2000);
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
      setImportError(intl.formatMessage({ id: 'settings.dangerZone.primaryKey.error.exportFailed' }));
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
          setImportError(intl.formatMessage({ id: 'settings.dangerZone.primaryKey.error.missingSecret' }));
          return;
        }
        setPendingBackup({
          masterSecret: secret,
          apiKey: parsed.apiKey,
          machines: parsed.machines,
        });
      } catch {
        setImportError(intl.formatMessage({ id: 'settings.dangerZone.primaryKey.error.parseFailed' }));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handlePasteRestore(): void {
    if (!pastedKey.trim()) {
      setImportError(intl.formatMessage({ id: 'settings.dangerZone.primaryKey.error.emptyPaste' }));
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
      setImportError(
        err instanceof Error
          ? err.message
          : intl.formatMessage({ id: 'settings.dangerZone.primaryKey.error.importFailed' }),
      );
      setPendingBackup(null);
    }
  }

  const copyLabelId =
    copyState === 'copied'
      ? 'settings.dangerZone.primaryKey.copied'
      : copyState === 'failed'
        ? 'settings.dangerZone.primaryKey.copyFailed'
        : 'settings.dangerZone.primaryKey.copy';

  const pastePlaceholder = intl.formatMessage({
    id: 'settings.dangerZone.primaryKey.restoreFromPastePlaceholder',
  });

  const confirmMachineCount = pendingBackup?.machines?.length ?? 0;

  return (
    <>
      <div className="space-y-4">
        <p className="text-sm font-medium text-white">
          <FormattedMessage id="settings.dangerZone.primaryKey.label" />
        </p>
        <p className="text-xs text-slate-400">
          <FormattedMessage id="settings.dangerZone.primaryKey.description" />
        </p>

        {/* Export */}
        <div className="flex gap-2">
          <button
            onClick={handleCopySecret}
            className="flex-1 py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-white transition-colors"
          >
            <FormattedMessage id={copyLabelId} />
          </button>
          <button
            onClick={handleDownloadSecret}
            className="flex-1 py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-white transition-colors"
          >
            <FormattedMessage id="settings.dangerZone.primaryKey.download" />
          </button>
        </div>

        {/* Import */}
        <div className="space-y-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-white transition-colors"
          >
            <FormattedMessage id="settings.dangerZone.primaryKey.restoreFromFile" />
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
              <FormattedMessage id="settings.dangerZone.primaryKey.restoreFromPasteLabel" />
            </label>
            <textarea
              value={pastedKey}
              onChange={(e) => setPastedKey(e.target.value)}
              placeholder={pastePlaceholder}
              rows={3}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none font-mono text-sm"
            />
            <button
              onClick={handlePasteRestore}
              disabled={!pastedKey.trim()}
              className="w-full py-2 px-3 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md text-sm font-medium text-white transition-colors"
            >
              <FormattedMessage id="settings.dangerZone.primaryKey.restore" />
            </button>
          </div>
        </div>

        {importError && (
          <ErrorBox>{importError}</ErrorBox>
        )}

        {importSuccess && (
          <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
            <FormattedMessage id="settings.dangerZone.primaryKey.restoreSuccess" />
          </div>
        )}
      </div>

      {pendingBackup !== null && (
        <ConfirmModal
          title={<FormattedMessage id="settings.dangerZone.primaryKey.confirm.title" />}
          message={
            <>
              <FormattedMessage id="settings.dangerZone.primaryKey.confirm.message" />
              {pendingBackup.apiKey && (
                <>
                  {' '}
                  <FormattedMessage id="settings.dangerZone.primaryKey.confirm.messageWithApiKey" />
                </>
              )}
              {confirmMachineCount > 0 && (
                <>
                  {' '}
                  <FormattedMessage
                    id="settings.dangerZone.primaryKey.confirm.messageWithMachines"
                    values={{ count: confirmMachineCount }}
                  />
                </>
              )}
            </>
          }
          confirmLabel={<FormattedMessage id="settings.dangerZone.primaryKey.restore" />}
          confirmText="restore"
          variant="danger"
          onConfirm={handleConfirmImport}
          onCancel={() => setPendingBackup(null)}
        />
      )}
    </>
  );
}
