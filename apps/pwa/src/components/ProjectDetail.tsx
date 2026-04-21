import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FormattedMessage, useIntl } from 'react-intl';
import { useClaudeStore } from '../stores/claudeStore';
import { useMachineStore } from '../stores/machineStore';
import { useConnectionStore } from '../stores/connectionStore';
import { BaseStatusBar, BackButton } from './BaseStatusBar';
import { Spinner } from './ui/Spinner';
import { ConfirmModal } from './ui/ConfirmModal';
import { pathToHash } from '../lib/pathHash';
import type {
  ClaudeSessionSummary,
  ProjectRepo,
  ProjectDeleteResponsePayload,
  SessionListArchivedResponsePayload,
} from '@sumicom/quicksave-shared';
import { ArchivedSessionsList } from './ArchivedSessionsList';
import { SessionTicketCard } from './SessionTicketCard';

interface ProjectDetailProps {
  isReady: boolean;
  isConnecting: boolean;
  isError: boolean;
  cwd: string | undefined;
  agentId: string;
  onListProjectRepos?: (cwd: string) => Promise<ProjectRepo[] | null>;
  onDeleteProject?: (cwd: string) => Promise<ProjectDeleteResponsePayload | null>;
  onRestartAgent?: () => Promise<{ success: boolean; error?: string }>;
  onListArchivedSessions?: (cwd: string, offset?: number, limit?: number) => Promise<SessionListArchivedResponsePayload | null>;
  onRestoreSession?: (sessionId: string, cwd: string) => Promise<void>;
}

export function ProjectDetail({
  isReady,
  isConnecting,
  isError,
  cwd,
  agentId,
  onListProjectRepos,
  onDeleteProject,
  onRestartAgent,
  onListArchivedSessions,
  onRestoreSession,
}: ProjectDetailProps) {
  const intl = useIntl();
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const sessions = useClaudeStore((s) => s.sessions);
  const error = useConnectionStore((s) => s.error);
  const removeProject = useMachineStore((s) => s.removeProject);
  const [showMenu, setShowMenu] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const cacheProjectRepos = useMachineStore((s) => s.cacheProjectRepos);

  // Use cached repos as initial state, update from agent when connected
  const machine = useMachineStore((s) => s.machines.find((m) => m.agentId === agentId));
  const cachedRepos = cwd ? machine?.cachedProjects[cwd]?.repos : undefined;
  const [projectRepos, setProjectRepos] = useState<ProjectRepo[]>(cachedRepos || []);

  const displayName = cwd?.split('/').pop() || cwd || 'Project';

  // Fetch repos when connected
  const fetchRepos = useCallback(async () => {
    if (!isReady || !cwd || !onListProjectRepos) return;
    setIsLoadingRepos(true);
    const repos = await onListProjectRepos(cwd);
    if (repos) {
      setProjectRepos(repos);
      cacheProjectRepos(agentId, cwd, repos);
    }
    setIsLoadingRepos(false);
  }, [isReady, cwd, agentId, onListProjectRepos, cacheProjectRepos]);

  // Load cached repos immediately, then refresh from agent
  useEffect(() => {
    if (cachedRepos?.length && projectRepos.length === 0) {
      setProjectRepos(cachedRepos);
    }
    fetchRepos();
  }, [fetchRepos]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectSession = useCallback((session: ClaudeSessionSummary) => {
    navigate(`/p/${projectId}/s/${session.sessionId}`);
  }, [navigate, projectId]);

  const handleNewSession = useCallback(() => {
    if (!projectId) return;
    navigate(`/add?tab=session&projectId=${encodeURIComponent(projectId)}`);
  }, [navigate, projectId]);

  const handleRemoveProject = useCallback(async () => {
    if (!cwd || !agentId) return;
    const result = await onDeleteProject?.(cwd);
    if (result && !result.success) {
      console.error('Failed to delete project:', result.error);
      return;
    }
    removeProject(agentId, cwd);
    navigate('/', { replace: true });
  }, [cwd, agentId, onDeleteProject, removeProject, navigate]);

  // Filter sessions for this project: must match both the resolved cwd AND
  // the owning machine agent, since two machines can share the same cwd
  // string (e.g. `/home/user/foo` on two Linux boxes) and the store now
  // holds sessions from every connected agent.
  const cwdSessions = Object.values(sessions)
    .filter((s) => (!s.machineAgentId || s.machineAgentId === agentId) && (s.cwd === cwd || (!s.cwd && isReady)))
    .sort((a, b) => {
      const rankA = a.isStreaming ? 2 : a.isActive ? 1 : 0;
      const rankB = b.isStreaming ? 2 : b.isActive ? 1 : 0;
      if (rankA !== rankB) return rankB - rankA;
      return b.lastModified - a.lastModified;
    });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <BaseStatusBar
        left={<BackButton onClick={() => navigate(-1)} />}
        center={
          <span className="text-sm font-medium text-slate-300 truncate" title={cwd}>
            {displayName}
          </span>
        }
        right={
          <div className="relative">
            <button
              onClick={() => setShowMenu((prev) => !prev)}
              className="p-1.5 rounded-md transition-colors hover:bg-slate-700 text-slate-400"
              aria-label={intl.formatMessage({ id: 'projectDetail.settings.aria' })}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01" />
              </svg>
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-slate-700 rounded-lg shadow-xl border border-slate-600 py-1">
                  {onRestartAgent && (
                    <button
                      onClick={async () => {
                        setShowMenu(false);
                        const result = await onRestartAgent();
                        if (!result.success) {
                          console.error('Failed to restart agent:', result.error);
                        }
                      }}
                      className="w-full text-left px-4 py-2 text-sm text-slate-300 hover:bg-slate-600 transition-colors"
                    >
                      <FormattedMessage id="projectDetail.menu.restartAgent" />
                    </button>
                  )}
                  <button
                    onClick={() => { setShowMenu(false); setShowRemoveConfirm(true); }}
                    className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-slate-600 transition-colors"
                  >
                    <FormattedMessage id="projectDetail.menu.deleteProject" />
                  </button>
                </div>
              </>
            )}
          </div>
        }
      />

      {/* Connecting state */}
      {isConnecting && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <Spinner size="w-8 h-8" color="border-blue-500" />
          <p className="text-sm text-slate-400">
            <FormattedMessage id="projectDetail.connecting" />
          </p>
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
            <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <p className="text-sm text-slate-400">
            {error || intl.formatMessage({ id: 'projectDetail.error.connectionFailed' })}
          </p>
          <button
            onClick={() => navigate('/')}
            className="text-sm text-blue-400 hover:text-blue-300"
          >
            <FormattedMessage id="projectDetail.error.backToProjects" />
          </button>
        </div>
      )}

      {/* Connected — two sections */}
      {isReady && (
        <div className="flex-1 overflow-y-auto safe-area-bottom">
          {/* Section 1: Coding Agent Sessions */}
          <div>
            <div className="px-4 pt-4 pb-2">
              <h2 className="text-[12px] font-medium text-slate-500 uppercase tracking-wider">
                <FormattedMessage id="projectDetail.sessions.title" />
              </h2>
            </div>

            {cwdSessions.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-slate-500">
                <FormattedMessage id="projectDetail.sessions.empty" />
              </div>
            ) : (
              <div className="divide-y divide-slate-700/40">
                {cwdSessions.map((session) => (
                  <SessionTicketCard
                    key={session.sessionId}
                    session={session}
                    onClick={() => handleSelectSession(session)}
                  />
                ))}
              </div>
            )}

            {/* New Session button */}
            <div className="px-4 py-2">
              <button
                onClick={handleNewSession}
                className="w-full text-left flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-slate-700/50 transition-colors"
              >
                <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <span className="text-sm text-blue-400 font-medium">
                  <FormattedMessage id="projectDetail.sessions.newTask" />
                </span>
              </button>
            </div>
          </div>

          {/* Archived Sessions (collapsible, paginated) */}
          {cwd && onListArchivedSessions && onRestoreSession && (
            <ArchivedSessionsList
              cwd={cwd}
              onListArchived={onListArchivedSessions}
              onRestore={onRestoreSession}
            />
          )}

          {/* Section 2: Git Repos */}
          <div>
            <div className="px-4 pt-4 pb-2">
              <h2 className="text-[12px] font-medium text-slate-500 uppercase tracking-wider">
                <FormattedMessage id="projectDetail.repos.title" />
              </h2>
            </div>

            {isLoadingRepos ? (
              <div className="flex items-center justify-center py-6">
                <Spinner size="w-5 h-5" color="border-blue-500" />
              </div>
            ) : projectRepos.length === 0 ? (
              <div className="px-4 py-4 text-center text-sm text-slate-500">
                <FormattedMessage id="projectDetail.repos.empty" />
              </div>
            ) : (
              <div className="divide-y divide-slate-700/40">
                {projectRepos.map((repo) => (
                  <button
                    key={repo.path}
                    onClick={() => navigate(`/p/${projectId}/r/${pathToHash(repo.path)}`)}
                    className="w-full text-left px-4 py-2.5 hover:bg-slate-700/50 active:bg-slate-700/60 transition-colors flex items-center gap-3"
                  >
                    <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <p className="list-title text-sm">{repo.name}</p>
                      <div className="list-meta flex items-center gap-1.5 mt-0.5 text-[11px]">
                        {repo.currentBranch && <span>{repo.currentBranch}</span>}
                        {repo.isSubmodule && (
                          <span className="opacity-70">
                            <FormattedMessage id="projectDetail.repos.submodule" />
                          </span>
                        )}
                      </div>
                    </div>
                    <svg className="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>
            )}

            {/* Repo actions */}
            <div className="px-4 py-2 flex items-center gap-2">
              <button
                onClick={fetchRepos}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-300 hover:bg-slate-700/50 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <FormattedMessage id="projectDetail.repos.refresh" />
              </button>
              {projectRepos.length === 0 && (
                <>
                  <button
                    onClick={async () => {
                      if (!cwd) return;
                      // TODO: wire to agent git init
                      console.log('git init', cwd);
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-blue-400 hover:text-blue-300 hover:bg-slate-700/50 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    <FormattedMessage id="projectDetail.repos.init" />
                  </button>
                  <button
                    onClick={() => {
                      // TODO: wire to agent git clone modal
                      console.log('git clone', cwd);
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-blue-400 hover:text-blue-300 hover:bg-slate-700/50 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    <FormattedMessage id="projectDetail.repos.clone" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showRemoveConfirm && (
        <ConfirmModal
          title={<FormattedMessage id="projectDetail.delete.title" />}
          message={<FormattedMessage id="projectDetail.delete.message" values={{ name: displayName }} />}
          confirmLabel={<FormattedMessage id="projectDetail.delete.confirmLabel" />}
          onConfirm={() => {
            setShowRemoveConfirm(false);
            void handleRemoveProject();
          }}
          onCancel={() => setShowRemoveConfirm(false)}
        />
      )}
    </div>
  );
}
