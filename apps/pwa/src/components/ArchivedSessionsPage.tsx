// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FormattedMessage } from 'react-intl';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { BaseStatusBar, BackButton } from './BaseStatusBar';
import { ArchivedSessionsList } from './ArchivedSessionsList';
import { useMachineStore } from '../stores/machineStore';
import { resolveProjectCwd } from '../lib/projectId';
import { getBusForAgent } from '../lib/busRegistry';
import { useClaudeOperations } from '../hooks/useClaudeOperations';

export function ArchivedSessionsPage() {
  const { agentId, projectId } = useParams<{ agentId: string; projectId: string }>();
  const navigate = useNavigate();

  const machine = useMachineStore((s) => s.machines.find((m) => m.agentId === agentId));
  const agentBus = useCallback(
    (): MessageBusClient | null => (agentId ? getBusForAgent(agentId) : null),
    [agentId],
  );
  const { listArchivedSessions, restoreSession } = useClaudeOperations(agentBus);

  const cwd = useMemo(() => {
    if (!projectId) return undefined;
    return resolveProjectCwd(projectId).cwd;
  }, [projectId]);

  // After the first successful restore, reshape history so iOS edge-swipe
  // (browser back) lands on the home page directly rather than walking back
  // through Settings → Machine. We do this with the raw History API so React
  // Router doesn't re-render — the user stays on the archived page UI; only
  // the previous history entry is changed. A ref guards against re-applying
  // on subsequent restores in the same mount (which would stack duplicate /
  // entries).
  const reshapedRef = useRef(false);
  const handleRestore = useCallback(
    async (sessionId: string, sessionCwd: string) => {
      await restoreSession(sessionId, sessionCwd);
      if (reshapedRef.current) return;
      reshapedRef.current = true;
      const currentUrl = window.location.pathname + window.location.search;
      window.history.replaceState(null, '', '/');
      window.history.pushState(null, '', currentUrl);
    },
    [restoreSession],
  );

  const displayName = cwd ? cwd.split('/').filter(Boolean).pop() || cwd : '';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <BaseStatusBar
        left={<BackButton onClick={() => navigate(-1)} />}
        center={
          <span className="text-sm font-medium text-slate-300 truncate">
            {displayName || <FormattedMessage id="archivedSessions.title" />}
          </span>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto p-4 space-y-3">
          <div className="space-y-1">
            {machine && (
              <p className="text-xs text-slate-500">
                {machine.nickname}
              </p>
            )}
            {cwd && (
              <p className="text-[11px] text-slate-500 font-mono break-all">{cwd}</p>
            )}
          </div>

          {!cwd ? (
            <p className="text-sm text-slate-400">
              <FormattedMessage id="archivedSessions.unknownProject" />
            </p>
          ) : (
            <div className="bg-slate-800/40 rounded-lg overflow-hidden">
              <ArchivedSessionsList
                cwd={cwd}
                onListArchived={listArchivedSessions}
                onRestore={handleRestore}
                defaultExpanded
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
