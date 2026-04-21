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
}

/**
 * Derives a sorted project list from machineStore + connectionStore + claudeStore.
 * For the connected machine, live session data overrides cached data.
 * Sorted by lastActivityAt desc.
 */
export function useProjects(): ProjectEntry[] {
  const machines = useMachineStore((s) => s.machines);
  const agentConnections = useConnectionStore((s) => s.agentConnections);
  const sessions = useClaudeStore((s) => s.sessions);

  return useMemo(() => {
    // Pre-compute live session stats keyed by `{agentId}\0{cwd}` so the same
    // cwd on two different machines doesn't collide.
    // Use lastPromptAt (stable during execution) in preference to lastModified
    // (updates on every streaming event — causes projects to jump in the list).
    const liveStats = new Map<string, { lastActivityAt: number; sessionCount: number; lastSessionTitle?: string; hasActiveSession: boolean }>();
    for (const session of Object.values(sessions)) {
      if (!session.cwd || !session.machineAgentId) continue;
      const key = `${session.machineAgentId}\0${session.cwd}`;
      const ts = session.lastPromptAt ?? session.lastModified;
      const existing = liveStats.get(key);
      if (!existing) {
        liveStats.set(key, {
          lastActivityAt: ts,
          sessionCount: 1,
          lastSessionTitle: session.summary,
          hasActiveSession: !!session.isActive,
        });
      } else {
        existing.sessionCount++;
        if (ts > existing.lastActivityAt) {
          existing.lastActivityAt = ts;
          existing.lastSessionTitle = session.summary;
        }
        if (session.isActive) existing.hasActiveSession = true;
      }
    }

    const entries: ProjectEntry[] = [];

    for (const machine of machines) {
      const conn = agentConnections[machine.agentId];
      // Treat relay-reported offline as disconnected even if the peer state
      // is still 'connected' — the WebRTC peer can stay up after the agent
      // loses its relay socket.
      const machineIsConnected = conn?.state === 'connected' && conn?.online !== false;

      // Build from cachedProjects (richer data) first
      const seenCwds = new Set<string>();

      for (const [cwd, cached] of Object.entries(machine.cachedProjects || {})) {
        seenCwds.add(cwd);
        const projectId = toProjectId(machine.agentId, cwd);
        const live = machineIsConnected ? liveStats.get(`${machine.agentId}\0${cwd}`) : undefined;
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
        });
      }

      // Also include knownCodingPaths not yet in cachedProjects
      for (const cwd of machine.knownCodingPaths || []) {
        if (seenCwds.has(cwd)) continue;
        const projectId = toProjectId(machine.agentId, cwd);
        const live = machineIsConnected ? liveStats.get(`${machine.agentId}\0${cwd}`) : undefined;
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
        });
      }
    }

    // Sort: projects with sessions before those without, then by
    // lastActivityAt desc, then alphabetically by displayName
    entries.sort((a, b) => {
      const aHas = a.sessionCount > 0 ? 1 : 0;
      const bHas = b.sessionCount > 0 ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
      return a.displayName.localeCompare(b.displayName);
    });

    return entries;
  }, [machines, agentConnections, sessions]);
}
