import { useState, useEffect } from 'react';
import { Spinner } from '../ui/Spinner';
import { useConnectionStore } from '../../stores/connectionStore';

interface AgentUpdateSectionProps {
  isOpen: boolean;
  onCheckAgentUpdate?: () => Promise<{ currentVersion: string; latestVersion?: string; updateAvailable: boolean; error?: string }>;
  onUpdateAgent?: () => Promise<{ success: boolean; previousVersion: string; newVersion?: string; restarting: boolean; error?: string }>;
}

export function AgentUpdateSection({ isOpen, onCheckAgentUpdate, onUpdateAgent }: AgentUpdateSectionProps) {
  const agentVersion = useConnectionStore((s) => s.agentVersion);
  const latestVersionFromStore = useConnectionStore((s) => s.latestVersion);
  const devBuild = useConnectionStore((s) => s.devBuild);
  const setLatestVersionInStore = useConnectionStore((s) => s.setLatestVersion);

  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!isOpen) setUpdateResult(null);
  }, [isOpen]);

  return (
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
                <Spinner size="w-3 h-3" />
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
                <Spinner color="border-white" />
                Updating...
              </>
            ) : (
              'Update Agent'
            )}
          </button>
        </>
      )}
    </div>
  );
}
