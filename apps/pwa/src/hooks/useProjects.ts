import { useMemo } from 'react';
import { useMachineStore } from '../stores/machineStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useClaudeStore } from '../stores/claudeStore';
import { toProjectId } from '../lib/projectId';

export interface ProjectEntry {
  projectId: string;
  agentId: string;
  cwd: string;
  displayName: string;
  machineName: string;
  machineIcon: string;
  lastActivityAt: number;
  sessionCount: number;
  lastSessionTitle?: string;
  hasActiveSession?: boolean;
  isConnected: boolean;
  isPinned: boolean;
}

/**
 * Derives a sorted project list from machineStore + connectionStore + claudeStore.
 * For the connected machine, live session data overrides cached data.
 * Pinned projects first, then sorted by lastActivityAt desc.
 */
export function useProjects(): ProjectEntry[] {
  const machines = useMachineStore((s) => s.machines);
  const pinnedProjects = useMachineStore((s) => s.pinnedProjects);
  const agentConnections = useConnectionStore((s) => s.agentConnections);
  const sessions = useClaudeStore((s) => s.sessions);

  return useMemo(() => {
    const pinnedSet = new Set(pinnedProjects);

    // Pre-compute live session stats per cwd from all sessions
    const liveStats = new Map<string, { lastActivityAt: number; sessionCount: number; lastSessionTitle?: string; hasActiveSession: boolean }>();
    for (const session of Object.values(sessions)) {
      if (!session.cwd) continue;
      const existing = liveStats.get(session.cwd);
      if (!existing) {
        liveStats.set(session.cwd, {
          lastActivityAt: session.lastModified,
          sessionCount: 1,
          lastSessionTitle: session.summary,
          hasActiveSession: !!session.isActive,
        });
      } else {
        existing.sessionCount++;
        if (session.lastModified > existing.lastActivityAt) {
          existing.lastActivityAt = session.lastModified;
          existing.lastSessionTitle = session.summary;
        }
        if (session.isActive) existing.hasActiveSession = true;
      }
    }

    const entries: ProjectEntry[] = [];

    for (const machine of machines) {
      const machineIsConnected = agentConnections[machine.agentId]?.state === 'connected';

      // Build from cachedProjects (richer data) first
      const seenCwds = new Set<string>();

      for (const [cwd, cached] of Object.entries(machine.cachedProjects || {})) {
        seenCwds.add(cwd);
        const projectId = toProjectId(machine.agentId, cwd);
        const live = machineIsConnected ? liveStats.get(cwd) : undefined;
        entries.push({
          projectId,
          agentId: machine.agentId,
          cwd,
          displayName: cwd.split('/').pop() || cwd,
          machineName: machine.nickname,
          machineIcon: machine.icon,
          lastActivityAt: live ? Math.max(live.lastActivityAt, cached.lastActivityAt) : cached.lastActivityAt,
          sessionCount: live ? live.sessionCount : cached.sessionCount,
          lastSessionTitle: live?.lastSessionTitle ?? cached.lastSessionTitle,
          hasActiveSession: live?.hasActiveSession,
          isConnected: machineIsConnected,
          isPinned: pinnedSet.has(projectId),
        });
      }

      // Also include knownCodingPaths not yet in cachedProjects
      for (const cwd of machine.knownCodingPaths || []) {
        if (seenCwds.has(cwd)) continue;
        const projectId = toProjectId(machine.agentId, cwd);
        const live = machineIsConnected ? liveStats.get(cwd) : undefined;
        entries.push({
          projectId,
          agentId: machine.agentId,
          cwd,
          displayName: cwd.split('/').pop() || cwd,
          machineName: machine.nickname,
          machineIcon: machine.icon,
          lastActivityAt: live?.lastActivityAt ?? machine.lastConnectedAt ?? machine.addedAt,
          sessionCount: live?.sessionCount ?? 0,
          lastSessionTitle: live?.lastSessionTitle,
          hasActiveSession: live?.hasActiveSession,
          isConnected: machineIsConnected,
          isPinned: pinnedSet.has(projectId),
        });
      }
    }

    // Sort: pinned first, then projects with sessions before those without,
    // then by lastActivityAt desc, then alphabetically by displayName
    entries.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      const aHas = a.sessionCount > 0 ? 1 : 0;
      const bHas = b.sessionCount > 0 ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
      return a.displayName.localeCompare(b.displayName);
    });

    return entries;
  }, [machines, pinnedProjects, agentConnections, sessions]);
}
