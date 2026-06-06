// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * WebRTC diagnostics for the streaming-voice path. Runs a one-shot connectivity
 * test against the connected agent (using a throwaway session id — independent
 * of any coding session) and surfaces the full ICE/DTLS lifecycle: candidate
 * types gathered, connection-state timeline, DataChannel open, and the selected
 * candidate pair. Built to diagnose the "live voice unavailable" failures
 * (mDNS-only on Safari/iOS, no srflx across NAT, agent missing wrtc, …).
 */
import { useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useConnectionStore } from '../../stores/connectionStore';
import { getVoiceConfig } from '../../lib/secureStorage';
import {
  VoiceStreamSession,
  type IceCandidateType,
  type VoiceRtcDebugEvent,
} from '../../lib/voiceStreamClient';

const KIND_COLOR: Record<VoiceRtcDebugEvent['kind'], string> = {
  info: 'text-slate-400',
  'local-candidate': 'text-sky-400',
  'remote-candidate': 'text-indigo-400',
  'pc-state': 'text-amber-400',
  dc: 'text-emerald-400',
  sdp: 'text-slate-300',
  result: 'text-purple-300',
  error: 'text-red-400',
};

type CandidateCounts = Partial<Record<IceCandidateType, number>>;

function countCandidates(events: VoiceRtcDebugEvent[], kind: 'local-candidate' | 'remote-candidate'): CandidateCounts {
  const counts: CandidateCounts = {};
  for (const e of events) {
    if (e.kind !== kind) continue;
    const t = (e.data?.type as IceCandidateType) ?? 'unknown';
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

function countsString(counts: CandidateCounts): string {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([k, v]) => `${k}×${v}`).join('  ') : '（無）';
}

export function VoiceRtcDebugPanel() {
  const agentId = useConnectionStore((s) => s.agentId);
  const connected = useConnectionStore((s) => s.state === 'connected');
  const [events, setEvents] = useState<VoiceRtcDebugEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const sessionRef = useRef<VoiceStreamSession | null>(null);

  async function runTest() {
    if (running) return;
    if (!agentId || !connected) {
      setVerdict({ ok: false, text: '未連線到 agent' });
      return;
    }
    const config = await getVoiceConfig();
    if (!config) {
      setVerdict({ ok: false, text: '語音尚未在設定中配置' });
      return;
    }

    setEvents([]);
    setStats(null);
    setVerdict(null);
    setRunning(true);

    const collected: VoiceRtcDebugEvent[] = [];
    const push = (e: VoiceRtcDebugEvent) => {
      collected.push(e);
      setEvents([...collected]);
    };

    const session = new VoiceStreamSession(
      agentId,
      crypto.randomUUID(),
      config,
      {
        onPartial: () => {},
        onFinal: () => {},
        onError: (m) => push({ t: 0, kind: 'error', detail: m }),
        onState: () => {},
      },
      push,
    );
    sessionRef.current = session;
    try {
      const ok = await session.connect({ acquireMic: true });
      setVerdict(
        ok
          ? { ok: true, text: 'P2P 連線成功（DataChannel open）' }
          : { ok: false, text: '無法建立 P2P — 看下方時間軸與候選類型找原因' },
      );
      setStats(await session.getDebugStats());
    } finally {
      session.close();
      sessionRef.current = null;
      setRunning(false);
    }
  }

  const localCounts = countCandidates(events, 'local-candidate');
  const remoteCounts = countCandidates(events, 'remote-candidate');
  const hasSrflx = (localCounts.srflx ?? 0) > 0;
  const onlyMdns = (localCounts.mdns ?? 0) > 0 && (localCounts.host ?? 0) === 0 && !hasSrflx;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={runTest}
          disabled={running || !connected}
          className="px-3 py-1.5 text-xs rounded-md bg-purple-600 hover:bg-purple-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white"
        >
          {running ? '測試中…' : '跑連線測試'}
        </button>
        {events.length > 0 && !running && (
          <button
            type="button"
            onClick={() => { setEvents([]); setStats(null); setVerdict(null); }}
            className="px-2 py-1.5 text-xs rounded-md text-slate-400 hover:bg-slate-700/60"
          >
            清除
          </button>
        )}
        <span className="text-[11px] text-slate-500">會請求麥克風權限（模擬實際點擊路徑）</span>
      </div>

      {verdict && (
        <div className={clsx('text-xs rounded-md px-2 py-1.5', verdict.ok ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400')}>
          {verdict.ok ? '✅ ' : '❌ '}
          {verdict.text}
        </div>
      )}

      {events.length > 0 && (
        <div className="text-[11px] text-slate-400 space-y-1">
          <div>本地候選：<span className="font-mono text-slate-300">{countsString(localCounts)}</span></div>
          <div>遠端候選：<span className="font-mono text-slate-300">{countsString(remoteCounts)}</span></div>
          {onlyMdns && (
            <div className="text-amber-400">⚠ 只有 mDNS 候選 — 同網段 P2P 可能連不上（Safari/iOS 要先授權麥克風才會出 host 候選）。</div>
          )}
          {!onlyMdns && !hasSrflx && events.some((e) => e.kind === 'local-candidate') && (
            <div className="text-amber-400">⚠ 沒有 srflx（STUN 反射）候選 — 跨 NAT 會失敗（本專案沒有 TURN）。</div>
          )}
          {stats && (
            <div>選定配對：<span className="font-mono text-slate-300">{JSON.stringify(stats)}</span></div>
          )}
        </div>
      )}

      {events.length > 0 && (
        <div className="max-h-56 overflow-auto rounded-md bg-slate-900/60 border border-slate-700 p-2 font-mono text-[11px] leading-relaxed">
          {events.map((e, i) => (
            <div key={i} className={KIND_COLOR[e.kind]}>
              <span className="text-slate-600">{String(e.t).padStart(5)}ms </span>
              <span className="text-slate-500">[{e.kind}]</span> {e.detail}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
