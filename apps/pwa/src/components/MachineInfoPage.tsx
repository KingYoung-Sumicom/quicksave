import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FormattedMessage } from 'react-intl';
import { BaseStatusBar, BackButton } from './BaseStatusBar';
import { Spinner } from './ui/Spinner';
import { useMachineStore } from '../stores/machineStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useProjects } from '../hooks/useProjects';

interface MachineInfoPageProps {
  onSetActiveAgent: (agentId: string) => void;
  onCheckAgentUpdate?: () => Promise<{ currentVersion: string; latestVersion?: string; updateAvailable: boolean; error?: string }>;
  onUpdateAgent?: () => Promise<{ success: boolean; previousVersion: string; newVersion?: string; restarting: boolean; error?: string }>;
  onRestartAgent?: () => Promise<{ success: boolean; error?: string }>;
}

/**
 * Per-machine info page. Surfaces the CLI agent version (and update/restart
 * controls) that used to live in the in-session settings drawer. We bind the
 * client to this machine's agent on mount so the shared `onCheckAgentUpdate`
 * etc. handlers route to the correct peer — the same `setActiveAgent`
 * convention the project routes use.
 */
export function MachineInfoPage({
  onSetActiveAgent,
  onCheckAgentUpdate,
  onUpdateAgent,
  onRestartAgent,
}: MachineInfoPageProps) {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();

  const machine = useMachineStore((s) => s.machines.find((m) => m.agentId === agentId));
  const conn = useConnectionStore((s) => (agentId ? s.agentConnections[agentId] : undefined));
  const isOnline = conn?.state === 'connected' && conn?.online !== false;

  const allProjects = useProjects();
  const machineProjects = useMemo(
    () => allProjects.filter((p) => p.agentId === agentId),
    [allProjects, agentId],
  );

  // The per-agent shape only stores agentVersion; latestVersion/devBuild are
  // mirrored from the *active* agent's connection. Routing the active agent
  // to this machine on mount lines up the globals with what we display.
  const agentVersion = conn?.agentVersion ?? null;
  const latestVersion = useConnectionStore((s) => s.latestVersion);
  const devBuild = useConnectionStore((s) => s.devBuild);
  const setLatestVersion = useConnectionStore((s) => s.setLatestVersion);

  useEffect(() => {
    if (agentId) onSetActiveAgent(agentId);
  }, [agentId, onSetActiveAgent]);

  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<{ success: boolean; message: string } | null>(null);

  if (!machine) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <BaseStatusBar
          left={<BackButton onClick={() => navigate(-1)} />}
          center={<span className="text-sm font-medium text-slate-300">Machine</span>}
        />
        <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
          Machine not found.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <BaseStatusBar
        left={<BackButton onClick={() => navigate(-1)} />}
        center={<span className="text-sm font-medium text-slate-300 truncate">{machine.nickname}</span>}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto p-4 space-y-6">

          {/* Identity card */}
          <div className="flex items-center gap-3 p-3 bg-slate-700/50 rounded-lg">
            <div className="relative w-12 h-12 bg-slate-700 rounded-lg flex items-center justify-center text-2xl flex-shrink-0">
              {machine.icon}
              <span
                className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-slate-800 ${
                  isOnline ? 'bg-green-500' : 'bg-slate-500'
                }`}
                aria-label={isOnline ? 'Online' : 'Offline'}
              />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-medium text-white truncate">{machine.nickname}</p>
              <p className="text-xs text-slate-400 font-mono truncate">{machine.agentId}</p>
            </div>
          </div>

          {/* CLI Agent section — moved here from the in-session settings drawer
              so version checks live with the rest of the per-machine UI. */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              CLI Agent
            </h3>

            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-300">Version</p>
              <span className="text-sm font-mono text-slate-400">
                {agentVersion || (isOnline ? 'unknown' : 'offline')}{devBuild && isOnline ? ' (dev)' : ''}
              </span>
            </div>

            {!isOnline && (
              <p className="text-xs text-slate-500">
                Connect to this machine to check or update the agent.
              </p>
            )}

            {isOnline && devBuild && (
              <div className="space-y-2">
                {restartResult && (
                  <div className={`p-2 rounded text-sm ${
                    restartResult.success
                      ? 'bg-green-500/20 border border-green-500/50 text-green-400'
                      : 'bg-red-500/20 border border-red-500/50 text-red-400'
                  }`}>
                    {restartResult.message}
                  </div>
                )}
                <button
                  onClick={async () => {
                    if (!onRestartAgent) return;
                    setIsRestarting(true);
                    setRestartResult(null);
                    try {
                      const result = await onRestartAgent();
                      if (result.success) {
                        setRestartResult({ success: true, message: 'Agent is restarting...' });
                      } else {
                        setRestartResult({ success: false, message: result.error || 'Restart failed' });
                      }
                    } catch (err) {
                      setRestartResult({ success: false, message: err instanceof Error ? err.message : 'Restart failed' });
                    } finally {
                      setIsRestarting(false);
                    }
                  }}
                  disabled={isRestarting || !onRestartAgent}
                  className="w-full py-2 px-4 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2"
                >
                  {isRestarting ? (
                    <>
                      <Spinner color="border-white" />
                      Restarting...
                    </>
                  ) : (
                    'Restart Agent'
                  )}
                </button>
              </div>
            )}

            {isOnline && !devBuild && (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-300">Latest</p>
                  <span className="text-sm font-mono text-slate-400 flex items-center gap-2">
                    {isCheckingUpdate ? (
                      <Spinner size="w-3 h-3" />
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

          {/* Projects section — lists the projects/cwds that exist on this
              machine, navigable to the project detail page. */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              <FormattedMessage id="machineInfo.projects.title" />
            </h3>

            {machineProjects.length === 0 ? (
              <p className="text-xs text-slate-500">
                <FormattedMessage id="machineInfo.projects.empty" />
              </p>
            ) : (
              <div className="divide-y divide-slate-700/40 rounded-lg bg-slate-700/30 overflow-hidden">
                {machineProjects.map((project) => (
                  <button
                    key={project.projectId}
                    onClick={() => navigate(`/p/${project.projectId}`)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-700/60 active:bg-slate-700/80 transition-colors"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${project.isConnected ? 'bg-emerald-400' : 'bg-slate-500'}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white truncate">{project.displayName}</div>
                      <div className="text-[11px] text-slate-500 font-mono truncate">{project.cwd}</div>
                    </div>
                    {project.sessionCount > 0 && (
                      <span className="text-[11px] text-slate-400 shrink-0">
                        <FormattedMessage
                          id="machineInfo.projects.sessionCount"
                          values={{ count: project.sessionCount }}
                        />
                      </span>
                    )}
                    <svg className="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
