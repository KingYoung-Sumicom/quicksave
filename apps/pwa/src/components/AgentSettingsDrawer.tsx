import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { SwipeableDrawer } from './SwipeableDrawer';
import { Modal } from './ui/Modal';
import type { ConfigValue, ProjectRepo, SessionControlRequestResponsePayload } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';
import { useConnectionStore } from '../stores/connectionStore';
import { ClaudeSettingsSection } from './settings/ClaudeSettingsSection';
import { ControlRequestPalette } from './settings/ControlRequestPalette';
import { pathToHash } from '../lib/pathHash';

interface AgentSettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Session ID from URL — fallback when store activeSessionId is null (inactive session) */
  sessionId?: string;
  /** Project ID from the route — used to navigate to repo views from the drawer. */
  projectId?: string;
  /** Agent ID owning the current project — used to look up its available repos. */
  agentId?: string;
  /** Project cwd — repos under this path are listed in the Git repository section. */
  cwd?: string;
  /** Fetches the full per-project repo list (incl. submodules + dirty state).
   *  Called lazily when the drawer opens. Falls back to the handshake-time
   *  availableRepos list if this is absent or the call fails. */
  onListProjectRepos?: (cwd: string) => Promise<ProjectRepo[] | null>;
  onSetSessionConfig?: (key: string, value: ConfigValue) => void;
  onSendControlRequest?: (sessionId: string, subtype: string, params?: Record<string, unknown>) => Promise<SessionControlRequestResponsePayload>;
  onCancelSession?: () => void;
  /** Terminate the underlying CLI process only — registry entry stays active. */
  onCloseSession?: () => void;
  /** End the task: terminate process AND archive the registry entry so the
   *  session leaves the active list. */
  onEndSession?: () => void;
}

export function AgentSettingsDrawer({
  isOpen,
  onClose,
  sessionId: sessionIdProp,
  projectId,
  agentId,
  cwd,
  onListProjectRepos,
  onSetSessionConfig,
  onSendControlRequest,
  onCancelSession,
  onCloseSession,
  onEndSession,
}: AgentSettingsDrawerProps) {
  const navigate = useNavigate();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showControlPalette, setShowControlPalette] = useState(false);
  const storeSessionId = useClaudeStore((s) => s.activeSessionId);
  const activeSessionId = storeSessionId || sessionIdProp || null;
  const localIsStreaming = useClaudeStore((s) => s.isStreaming);
  const sessions = useClaudeStore((s) => s.sessions);
  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;
  const isStreaming = localIsStreaming || !!activeSession?.isStreaming;
  // Codex sessions don't speak the Claude CLI control_request protocol — only
  // expose the palette when the active session is Claude Code.
  const isClaudeCode = activeSession?.agent === 'claude-code';

  // Repos under this project's cwd. `listProjectRepos` walks the tree and
  // returns submodules + nested repos + dirty state; we prefer its output
  // over the handshake-time availableRepos list, which is flat and stale.
  // The filtered availableRepos is a synchronous fallback so the section
  // doesn't flash empty while the RPC is in flight.
  const agentConn = useConnectionStore((s) => (agentId ? s.agentConnections[agentId] : undefined));
  const [fetchedRepos, setFetchedRepos] = useState<ProjectRepo[] | null>(null);

  const fallbackRepos = useMemo<ProjectRepo[]>(() => {
    if (!cwd || !agentConn?.availableRepos) return [];
    return agentConn.availableRepos
      .filter((r) => r.path === cwd || r.path.startsWith(cwd + '/'))
      .map((r) => ({ path: r.path, name: r.name, currentBranch: r.currentBranch }));
  }, [agentConn?.availableRepos, cwd]);

  const projectRepos = fetchedRepos ?? fallbackRepos;

  // Refresh the list every time the drawer opens so dirty indicators reflect
  // the current working-tree state rather than the snapshot from last open.
  useEffect(() => {
    if (!isOpen || !cwd || !onListProjectRepos) return;
    let cancelled = false;
    onListProjectRepos(cwd).then((repos) => {
      if (cancelled) return;
      if (repos) setFetchedRepos(repos);
    });
    return () => { cancelled = true; };
  }, [isOpen, cwd, onListProjectRepos]);

  const handleOpenRepo = (repoPath: string) => {
    if (!projectId) return;
    navigate(`/p/${projectId}/r/${pathToHash(repoPath)}`);
    onClose();
  };

  const handleOpenFiles = () => {
    if (!projectId) return;
    navigate(`/p/${projectId}/files`);
    onClose();
  };

  return (
    <SwipeableDrawer isOpen={isOpen} onClose={onClose} side="right" drawerWidth={400} className="w-[90%] max-w-[400px] bg-slate-800 flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">Utilities</h2>
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

          {/* Section: Agent — only shown for new sessions; active-session fields live in the status bar */}
          {!activeSessionId && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Agent
              </h3>
              <ClaudeSettingsSection
                sessionId={null}
                onSetConfig={onSetSessionConfig}
              />
            </div>
          )}

          {/* Section: Task — Stop interrupts the current turn; End Task closes
              the session AND archives it (it disappears from the active list).
              Force-killing just the CLI process without archiving lives under
              Advanced. */}
          {activeSessionId && (onCancelSession || onEndSession) && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Task
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
                {onEndSession && (
                  <button
                    onClick={() => { onEndSession(); onClose(); }}
                    className="flex-1 py-2 px-3 bg-red-600/20 hover:bg-red-600/30 border border-red-600/50 rounded-md text-sm font-medium text-red-400 transition-colors"
                  >
                    End Task
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Section: Git repository — repo switcher. Only shown when the drawer
              has project context (projectId + cwd) and the agent has reported
              repos under that cwd. An amber dot next to the name means the
              repo has uncommitted/unstaged/untracked changes. */}
          {projectId && projectRepos.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Git repository
              </h3>
              <div className="space-y-1.5">
                {projectRepos.map((repo) => (
                  <button
                    key={repo.path}
                    type="button"
                    onClick={() => handleOpenRepo(repo.path)}
                    className="w-full flex items-center gap-2 py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-slate-200 transition-colors text-left"
                  >
                    <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                    </svg>
                    <span className="flex-1 min-w-0 flex items-center gap-1.5">
                      <span className="truncate">{repo.name}</span>
                      {repo.hasChanges && (
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
                          aria-label="Uncommitted changes"
                          title="Uncommitted changes"
                        />
                      )}
                    </span>
                    {repo.currentBranch && (
                      <span className="text-[11px] text-slate-400 font-mono truncate max-w-[40%]">
                        {repo.currentBranch}
                      </span>
                    )}
                    <svg className="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Section: Files — read-only browser for the project tree. */}
          {projectId && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Files
              </h3>
              <button
                type="button"
                onClick={handleOpenFiles}
                className="w-full flex items-center gap-2 py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-slate-200 transition-colors text-left"
              >
                <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                </svg>
                <span className="flex-1 truncate">Browse project files</span>
                <svg className="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          )}

          {/* Section: Advanced — collapsed by default. Holds the force-kill
              option that terminates the underlying CLI process without
              archiving the session, so a stuck CLI can be restarted while
              keeping the entry in the active list. */}
          {activeSessionId && onCloseSession && (
            <>
              <div className="border-t border-slate-700" />
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  aria-expanded={advancedOpen}
                  className="w-full flex items-center justify-between text-left"
                >
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                    Advanced
                  </h3>
                  <svg
                    className={`w-4 h-4 text-slate-500 transition-transform ${advancedOpen ? 'rotate-90' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                {advancedOpen && (
                  <div className="space-y-2">
                    {isClaudeCode && onSendControlRequest && (
                      <button
                        type="button"
                        onClick={() => setShowControlPalette(true)}
                        className="w-full flex items-center justify-between py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-slate-200 transition-colors"
                      >
                        <span>Control Request Palette</span>
                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => { onCloseSession(); onClose(); }}
                      className="w-full py-2 px-3 bg-red-600/20 hover:bg-red-600/30 border border-red-600/50 rounded-md text-sm font-medium text-red-400 transition-colors"
                    >
                      Terminate Coding Agent Process
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Control Request Palette Modal */}
        {showControlPalette && activeSessionId && onSendControlRequest && (
          <Modal
            title="Control Request Palette"
            onClose={() => setShowControlPalette(false)}
            maxWidth="max-w-2xl"
          >
            <div className="p-4">
              <ControlRequestPalette
                sessionId={activeSessionId}
                onSendControlRequest={onSendControlRequest}
              />
            </div>
          </Modal>
        )}
    </SwipeableDrawer>
  );
}
