import { useState, useEffect } from 'react';
import { SwipeableDrawer } from './SwipeableDrawer';
import type { ConfigValue } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';
import { useConnectionStore } from '../stores/connectionStore';
import { ClaudeSettingsSection } from './settings/ClaudeSettingsSection';

interface AgentSettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSetSessionConfig?: (key: string, value: ConfigValue) => void;
  onCancelSession?: () => void;
  onCloseSession?: () => void;
  onCheckAgentUpdate?: () => Promise<{ currentVersion: string; latestVersion?: string; updateAvailable: boolean; error?: string }>;
  onUpdateAgent?: () => Promise<{ success: boolean; previousVersion: string; newVersion?: string; restarting: boolean; error?: string }>;
}

export function AgentSettingsDrawer({
  isOpen,
  onClose,
  onSetSessionConfig,
  onCancelSession,
  onCloseSession,
  onCheckAgentUpdate,
  onUpdateAgent,
}: AgentSettingsDrawerProps) {
  const activeSessionId = useClaudeStore((s) => s.activeSessionId);
  const localIsStreaming = useClaudeStore((s) => s.isStreaming);
  const sessions = useClaudeStore((s) => s.sessions);
  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;
  const isStreaming = localIsStreaming || !!activeSession?.isStreaming;

  const agentVersion = useConnectionStore((s) => s.agentVersion);
  const latestVersion = useConnectionStore((s) => s.latestVersion);
  const devBuild = useConnectionStore((s) => s.devBuild);
  const setLatestVersion = useConnectionStore((s) => s.setLatestVersion);

  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!isOpen) setUpdateResult(null);
  }, [isOpen]);

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

          {/* Section: Claude — model, reasoning effort, permission */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Claude
            </h3>
            <ClaudeSettingsSection
              sessionId={activeSessionId}
              onSetConfig={onSetSessionConfig}
            />
          </div>

          {/* Section: Session Controls — only when there's an active session */}
          {activeSessionId && (onCancelSession || onCloseSession) && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Session
              </h3>
              <div className="flex gap-2">
                {onCancelSession && (
                  <button
                    onClick={() => { onCancelSession(); onClose(); }}
                    disabled={!isStreaming}
                    className="flex-1 py-2 px-3 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed rounded-md text-sm font-medium text-white transition-colors"
                  >
                    Stop
                  </button>
                )}
                {onCloseSession && (
                  <button
                    onClick={() => { onCloseSession(); onClose(); }}
                    className="flex-1 py-2 px-3 bg-red-600/20 hover:bg-red-600/30 border border-red-600/50 rounded-md text-sm font-medium text-red-400 transition-colors"
                  >
                    End Session
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Divider */}
          <div className="border-t border-slate-700" />

          {/* Section: CLI Agent */}
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
                      latestVersion || '—'
                    )}
                    {onCheckAgentUpdate && !isCheckingUpdate && (
                      <button
                        onClick={async () => {
                          setIsCheckingUpdate(true);
                          try {
                            const result = await onCheckAgentUpdate();
                            if (result.latestVersion) setLatestVersion(result.latestVersion);
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

                {latestVersion && agentVersion && latestVersion !== agentVersion && (
                  <div className="p-2 bg-amber-500/20 border border-amber-500/50 rounded text-sm text-amber-400">
                    New version available: {latestVersion}
                  </div>
                )}

                {latestVersion && agentVersion && latestVersion === agentVersion && !updateResult && (
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
                        if (result.newVersion) setLatestVersion(result.newVersion);
                      } else {
                        setUpdateResult({ success: false, message: result.error || 'Update failed' });
                      }
                    } catch (err) {
                      setUpdateResult({ success: false, message: err instanceof Error ? err.message : 'Update failed' });
                    } finally {
                      setIsUpdating(false);
                    }
                  }}
                  disabled={isUpdating || !onUpdateAgent || (!!latestVersion && latestVersion === agentVersion)}
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
        </div>
    </SwipeableDrawer>
  );
}
