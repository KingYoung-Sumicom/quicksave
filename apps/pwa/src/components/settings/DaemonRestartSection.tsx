// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { ConfirmModal } from '../ui/ConfirmModal';
import { ErrorBox } from '../ui/ErrorBox';
import { useConnectionStore } from '../../stores/connectionStore';
import { getBusForAgent } from '../../lib/busRegistry';
import type { AgentRestartResponsePayload } from '@sumicom/quicksave-shared';

type Phase = 'idle' | 'sending' | 'restarting';

/** Restart the Quicksave background daemon on every connected machine via
 *  the `agent:restart` bus verb. The daemon spawns its own successor, so the
 *  PWA connection drops briefly and reconnects on its own. */
export function DaemonRestartSection() {
  const agentConnections = useConnectionStore((s) => s.agentConnections);
  const connectedIds = Object.keys(agentConnections).filter(
    (agentId) => agentConnections[agentId]?.state === 'connected',
  );

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  // The "restarting" banner clears once the successor daemon comes back —
  // but only after the expected connection drop was actually observed, so a
  // fast restart cannot flash the banner for a single frame.
  const dropObserved = useRef(false);
  useEffect(() => {
    if (phase !== 'restarting') {
      dropObserved.current = false;
      return;
    }
    if (connectedIds.length === 0) dropObserved.current = true;
    else if (dropObserved.current) {
      dropObserved.current = false;
      setPhase('idle');
    }
  }, [phase, connectedIds.length]);

  async function handleRestart(): Promise<void> {
    setConfirmOpen(false);
    setPhase('sending');
    setError(null);
    try {
      await Promise.all(connectedIds.map(async (agentId) => {
        const bus = getBusForAgent(agentId);
        if (!bus) throw new Error(agentId);
        const response = await bus.command<AgentRestartResponsePayload>(
          'agent:restart',
          {},
          { timeoutMs: 30_000, queueWhileDisconnected: false },
        );
        if (!response.success) throw new Error(response.error ?? 'agent:restart failed');
      }));
      setPhase('restarting');
    } catch (err) {
      setPhase('idle');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        disabled={phase === 'sending' || connectedIds.length === 0}
        onClick={() => setConfirmOpen(true)}
        className="w-full py-2 px-4 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium"
      >
        <FormattedMessage id="settings.daemonRestart.button" />
      </button>
      <p className="text-xs text-slate-500">
        <FormattedMessage id="settings.daemonRestart.description" />
      </p>
      {phase === 'restarting' && (
        <div className="p-2 bg-blue-500/20 border border-blue-500/50 rounded text-sm text-blue-400">
          <FormattedMessage id="settings.daemonRestart.restarting" />
        </div>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      {confirmOpen && (
        <ConfirmModal
          title={<FormattedMessage id="settings.daemonRestart.confirm.title" />}
          message={<FormattedMessage id="settings.daemonRestart.confirm.message" />}
          confirmLabel={<FormattedMessage id="settings.daemonRestart.confirm.button" />}
          variant="primary"
          onConfirm={() => { void handleRestart(); }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
