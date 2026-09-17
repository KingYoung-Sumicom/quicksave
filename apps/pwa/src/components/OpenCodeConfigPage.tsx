// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { OpenCodeConfigSnapshotResponsePayload } from '@sumicom/quicksave-shared';
import { BaseStatusBar, BackButton } from './BaseStatusBar';
import { Spinner } from './ui/Spinner';
import { useMachineStore } from '../stores/machineStore';
import { useConnectionStore } from '../stores/connectionStore';
import { MaskedSecretInput } from './ui/MaskedSecretInput';

type GuardianSettingsInput = {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  enableThinking: boolean;
  timeoutMs: number;
  maxConsecutiveDenials: number;
};

export type GuardianTestDraft = { baseUrl: string; model: string; apiKey?: string };
export type GuardianTestResult = { success: boolean; configured: boolean; error?: string; latencyMs?: number };

export function OpenCodeConfigPage({
  onGetSnapshot,
  onUpsertMcp,
  onSetWebSearch,
  onSetGuardian,
  onTestGuardian,
}: {
  onGetSnapshot: () => Promise<OpenCodeConfigSnapshotResponsePayload>;
  onUpsertMcp: (name: string, config: { type: 'local' | 'remote'; command?: string[]; url?: string; headers?: Record<string, string> }) => Promise<{ success: boolean; error?: string }>;
  onSetWebSearch: (exaEnabled: boolean) => Promise<{ success: boolean; error?: string }>;
  onSetGuardian: (config: GuardianSettingsInput) => Promise<{ success: boolean; error?: string }>;
  onTestGuardian?: (draft: GuardianTestDraft) => Promise<GuardianTestResult>;
}) {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const machine = useMachineStore((s) => s.machines.find((item) => item.agentId === agentId));
  const connection = useConnectionStore((s) => (agentId ? s.agentConnections[agentId] : undefined));
  const online = connection?.state === 'connected' && connection.online !== false;
  const [snapshot, setSnapshot] = useState<OpenCodeConfigSnapshotResponsePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!online) return;
    setLoading(true);
    setError(null);
    try {
      const next = await onGetSnapshot();
      setSnapshot(next);
      if (!next.available && next.error) setError(next.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load OpenCode configuration');
    } finally {
      setLoading(false);
    }
  }, [online, onGetSnapshot]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <BaseStatusBar
        left={<BackButton onClick={() => navigate(-1)} />}
        center={<span className="text-sm font-medium text-slate-300 truncate">OpenCode · {machine?.nickname ?? 'Machine'}</span>}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto p-4">
          <OpenCodeConfigSection online={online} snapshot={snapshot} loading={loading} error={error} onLoad={() => void load()} onUpsertMcp={onUpsertMcp} onSetWebSearch={onSetWebSearch} onSetGuardian={onSetGuardian} onTestGuardian={onTestGuardian} />
        </div>
      </div>
    </div>
  );
}

type Detail = { title: string; kind: string; rows: Array<[string, string]> };

function OpenCodeConfigSection({ online, snapshot, loading, error, onLoad, onUpsertMcp, onSetWebSearch, onSetGuardian, onTestGuardian }: {
  online: boolean; snapshot: OpenCodeConfigSnapshotResponsePayload | null; loading: boolean; error: string | null; onLoad: () => void;
  onUpsertMcp: (name: string, config: { type: 'local' | 'remote'; command?: string[]; url?: string; headers?: Record<string, string> }) => Promise<{ success: boolean; error?: string }>;
  onSetWebSearch: (exaEnabled: boolean) => Promise<{ success: boolean; error?: string }>;
  onSetGuardian: (config: GuardianSettingsInput) => Promise<{ success: boolean; error?: string }>;
  onTestGuardian?: (draft: GuardianTestDraft) => Promise<GuardianTestResult>;
}) {
  const [selected, setSelected] = useState<Detail | null>(null);
  const [addingMcp, setAddingMcp] = useState(false);
  const [changingWebSearch, setChangingWebSearch] = useState(false);
  const [webSearchError, setWebSearchError] = useState<string | null>(null);
  const [editingGuardian, setEditingGuardian] = useState(false);
  const detail = (title: string, kind: string, rows: Array<[string, string | undefined]>): Detail => ({
    title, kind, rows: rows.filter((row): row is [string, string] => Boolean(row[1])),
  });
  return <section className="space-y-3">
    <div className="flex items-center justify-between gap-3">
      <div><h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Configuration</h3><p className="mt-1 text-[11px] text-slate-500">Sanitized view · credentials and raw config are never displayed</p></div>
      <button type="button" disabled={!online || loading} onClick={onLoad} className="px-2.5 py-1.5 rounded-md bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed text-xs text-slate-200 transition-colors flex items-center gap-1.5">{loading && <Spinner size="w-3 h-3" />}Refresh</button>
    </div>
    {!online ? <p className="text-xs text-slate-500">Connect to this machine to inspect its OpenCode configuration.</p>
      : error ? <div className="p-2 rounded border border-red-500/40 bg-red-500/10 text-xs text-red-300 break-words">{error}</div>
        : loading && !snapshot ? <div className="flex items-center gap-2 text-xs text-slate-400"><Spinner size="w-3 h-3" />Loading OpenCode configuration…</div>
          : !snapshot ? <p className="text-xs text-slate-500">No OpenCode configuration snapshot is available.</p>
            : <div className="space-y-3">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400"><span>OpenCode <span className="font-mono text-slate-300">{snapshot.version ?? 'unknown'}</span></span><span>schema <span className="font-mono text-slate-300">{snapshot.schema ?? 'unknown'}</span></span>{snapshot.defaultModel && <span className="truncate">default <span className="font-mono text-slate-300">{snapshot.defaultModel}</span></span>}</div>
              <div className="rounded-lg bg-slate-700/30 px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2"><p className="text-xs font-medium text-slate-200">Guardian auto-review</p><span className={`rounded-full px-1.5 py-0.5 text-[10px] ${snapshot.guardian.configured ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-600/60 text-slate-400'}`}>{snapshot.guardian.configured ? 'Configured' : 'Not configured'}</span>{snapshot.guardian.configured && snapshot.guardian.serverState?.status === 'failed' && <span className="rounded-full px-1.5 py-0.5 text-[10px] bg-red-500/15 text-red-300">Server unreachable</span>}</div>
                    <p className="mt-0.5 text-[11px] text-slate-500 break-all">{snapshot.guardian.configured ? `${snapshot.guardian.model} · ${snapshot.guardian.baseUrl}` : 'Required before OpenCode auto-review can be enabled.'}</p>
                    {snapshot.guardian.configured && snapshot.guardian.serverState?.status === 'failed' && <p className="mt-0.5 text-[11px] text-red-300/90 break-all">Last failure: {snapshot.guardian.serverState.lastError ?? 'unknown error'}</p>}
                  </div>
                  <button type="button" disabled={snapshot.guardian.source === 'environment'} onClick={() => setEditingGuardian(true)} className="shrink-0 px-2.5 py-1.5 rounded-md bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-xs text-slate-200">{snapshot.guardian.source === 'environment' ? 'Environment' : snapshot.guardian.configured ? 'Edit' : 'Configure'}</button>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">{snapshot.guardian.source === 'environment' ? 'Managed by QUICKSAVE_GUARDIAN_* environment variables.' : `Thinking ${snapshot.guardian.enableThinking ? 'enabled' : 'disabled'} · timeout ${Math.round(snapshot.guardian.timeoutMs / 1000)}s · manual review after ${snapshot.guardian.maxConsecutiveDenials} consecutive denials. Changes apply when a session enters or resumes auto-review.`}</p>
              </div>
              <div className="rounded-lg bg-slate-700/30 px-3 py-3"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="text-xs font-medium text-slate-200">Web search (Exa)</p><p className="mt-0.5 text-[11px] text-slate-500">OpenCode built-in tool · asks before searching</p></div><button type="button" role="switch" aria-checked={snapshot.websearch.exaEnabled} disabled={changingWebSearch} onClick={() => void (async () => { setChangingWebSearch(true); setWebSearchError(null); try { const result = await onSetWebSearch(!snapshot.websearch.exaEnabled); if (!result.success) throw new Error(result.error || 'Failed to update web search'); onLoad(); } catch (err) { setWebSearchError(err instanceof Error ? err.message : 'Failed to update web search'); } finally { setChangingWebSearch(false); } })()} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${snapshot.websearch.exaEnabled ? 'bg-purple-600' : 'bg-slate-600'}`}><span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${snapshot.websearch.exaEnabled ? 'translate-x-5' : 'translate-x-0'}`} /></button></div><p className="mt-2 text-[11px] text-slate-500">Applying restarts this machine’s OpenCode process; active OpenCode turns stop.</p>{webSearchError && <p className="mt-2 text-xs text-red-300">{webSearchError}</p>}</div>
              <OpenCodeGroup title="MCP" count={snapshot.mcp.length} empty="No MCP servers configured."><div className="px-3 py-2 border-b border-slate-700/40"><button type="button" onClick={() => setAddingMcp(true)} className="text-xs text-purple-300 hover:text-purple-200">+ Add MCP</button></div>{snapshot.mcp.map((item) => <OpenCodeRow key={item.name} title={item.name} onClick={() => setSelected(detail(item.name, 'MCP server', [['Transport', item.type], ['Enabled', item.enabled === undefined ? undefined : item.enabled ? 'Yes' : 'No'], ['Connection', item.status], ['Tools', item.toolCount === undefined ? undefined : String(item.toolCount)], ['Ownership', item.managed ? 'Managed by Quicksave' : 'User configuration']]))} detail={[item.type, item.enabled === false ? 'disabled' : item.enabled === true ? 'enabled' : undefined, item.status, item.toolCount !== undefined ? `${item.toolCount} tools` : undefined].filter(Boolean).join(' · ')} />)}</OpenCodeGroup>
              <OpenCodeGroup title="Providers & Models" count={snapshot.providers.length} empty="No providers reported." collapsible>{snapshot.providers.map((item) => <OpenCodeRow key={item.id} title={item.name} onClick={() => { const models = item.models ?? []; setSelected(detail(item.name, 'Provider', [['Provider ID', item.id], ['Connection', item.connected ? 'Connected' : 'Not connected'], ['Models', models.length > 0 ? models.map((model) => `${model.name} (${model.id})`).join('\n') : item.modelCount === 0 ? 'No models reported' : 'Model metadata unavailable — refresh after the agent update']])) }} detail={`${item.connected ? 'connected' : 'not connected'} · ${item.modelCount} models`} />)}</OpenCodeGroup>
              <OpenCodeGroup title="Agents" count={snapshot.agents.length} empty="No agents reported.">{snapshot.agents.map((item) => <OpenCodeRow key={item.name} title={item.name} onClick={() => setSelected(detail(item.name, 'Agent', [['Description', item.description], ['Mode', item.mode], ['Model', item.model]]))} detail={[item.description, item.mode, item.model].filter(Boolean).join(' · ')} />)}</OpenCodeGroup>
              <OpenCodeGroup title="Skills & Commands" count={snapshot.skills.length + snapshot.commands.length} empty="No skills or commands reported.">{snapshot.skills.map((item) => <OpenCodeRow key={`skill:${item.name}`} title={item.name} onClick={() => setSelected(detail(item.name, 'Skill', [['Location', item.location], ['Source', 'OpenCode configuration']]))} detail={item.location ? `skill · ${item.location}` : 'skill'} />)}{snapshot.commands.map((item) => <OpenCodeRow key={`command:${item.name}`} title={`/${item.name}`} onClick={() => setSelected(detail(`/${item.name}`, 'Command', [['Description', item.description], ['Source', 'OpenCode configuration']]))} detail={item.description ?? 'command'} />)}</OpenCodeGroup>
              <OpenCodeGroup title="Plugins" count={snapshot.plugins.length} empty="No plugins configured.">{snapshot.plugins.map((item) => <OpenCodeRow key={item.name} title={item.name} onClick={() => setSelected(detail(item.name, 'Plugin', [['Ownership', item.managed ? 'Managed by Quicksave' : 'User configuration']]))} detail={item.managed ? 'managed by Quicksave' : 'plugin'} />)}</OpenCodeGroup>
            </div>}
    {selected && <OpenCodeDetailModal detail={selected} onClose={() => setSelected(null)} />}
    {addingMcp && <McpEditor onClose={() => setAddingMcp(false)} onSave={async (name, config) => { const result = await onUpsertMcp(name, config); if (!result.success) throw new Error(result.error || 'Failed to save MCP'); setAddingMcp(false); onLoad(); }} />}
    {editingGuardian && snapshot && <GuardianEditor guardian={snapshot.guardian} onClose={() => setEditingGuardian(false)} onSave={async (config) => { const result = await onSetGuardian(config); if (!result.success) throw new Error(result.error || 'Failed to save Guardian settings'); setEditingGuardian(false); onLoad(); }} onTest={onTestGuardian} />}
  </section>;
}

export function GuardianEditor({ guardian, onClose, onSave, onTest }: {
  guardian: OpenCodeConfigSnapshotResponsePayload['guardian'];
  onClose: () => void;
  onSave: (config: GuardianSettingsInput) => Promise<void>;
  onTest?: (draft: GuardianTestDraft) => Promise<GuardianTestResult>;
}) {
  const [baseUrl, setBaseUrl] = useState(guardian.baseUrl ?? '');
  const [model, setModel] = useState(guardian.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [enableThinking, setEnableThinking] = useState(guardian.enableThinking);
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(Math.round(guardian.timeoutMs / 1000)));
  const [maxDenials, setMaxDenials] = useState(String(guardian.maxConsecutiveDenials));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<GuardianTestResult | null>(null);
  const test = async () => {
    if (!onTest) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await onTest({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      }));
    } catch (err) {
      setTestResult({ success: false, configured: true, error: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTesting(false);
    }
  };
  const save = async () => {
    setSaving(true); setError(null);
    try {
      await onSave({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: clearApiKey ? null : apiKey.trim() || undefined,
        enableThinking,
        timeoutMs: Number(timeoutSeconds) * 1000,
        maxConsecutiveDenials: Number(maxDenials),
      });
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to save Guardian settings'); }
    finally { setSaving(false); }
  };
  const partiallyConfigured = Boolean(baseUrl.trim()) !== Boolean(model.trim());
  return <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Guardian settings"><div className="w-full max-w-md rounded-t-xl sm:rounded-xl bg-slate-800 border border-slate-700 p-4 space-y-3"><div className="flex justify-between gap-3"><div><h2 className="text-sm font-medium text-white">Guardian auto-review</h2><p className="mt-1 text-[11px] text-slate-500">OpenAI-compatible chat completions server</p></div><button type="button" onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close Guardian settings">×</button></div><label className="block text-xs text-slate-400">Base URL<input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:8000/v1" className="mt-1 w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white font-mono" /></label><label className="block text-xs text-slate-400">Model<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="reviewer-model" className="mt-1 w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white font-mono" /></label><label className="block text-xs text-slate-400">API key {guardian.hasApiKey && <span className="text-slate-500">· stored</span>}<MaskedSecretInput value={apiKey} onChange={(value) => { setApiKey(value); setClearApiKey(false); }} placeholder={guardian.hasApiKey ? 'Leave blank to keep existing key' : 'Optional'} /></label>{guardian.hasApiKey && <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={clearApiKey} onChange={(e) => { setClearApiKey(e.target.checked); if (e.target.checked) setApiKey(''); }} />Clear stored API key</label>}<label className="flex items-center justify-between gap-3 rounded bg-slate-700/40 px-3 py-2 text-xs text-slate-300"><span><span className="block">Enable model thinking</span><span className="mt-0.5 block text-[11px] text-slate-500">May improve difficult reviews, but increases latency.</span></span><input type="checkbox" role="switch" aria-label="Enable model thinking" checked={enableThinking} onChange={(e) => setEnableThinking(e.target.checked)} /></label><div className="grid grid-cols-2 gap-3"><label className="block text-xs text-slate-400">Timeout (seconds)<input type="number" min="5" max="300" value={timeoutSeconds} onChange={(e) => setTimeoutSeconds(e.target.value)} className="mt-1 w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white" /></label><label className="block text-xs text-slate-400">Denials before manual review<input type="number" min="1" max="10" value={maxDenials} onChange={(e) => setMaxDenials(e.target.value)} className="mt-1 w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white" /></label></div><p className="text-[11px] text-slate-500">Clear both URL and model to disable Guardian. Credentials are stored only on this machine and are never returned to the browser.</p>{testResult && <p className={`text-xs break-all ${testResult.success ? 'text-emerald-300' : 'text-red-300'}`} aria-live="polite">{testResult.success ? `Connected · ${testResult.latencyMs ?? 0}ms` : `Test failed: ${testResult.error ?? 'unknown error'}`}</p>}{error && <p className="text-xs text-red-300">{error}</p>}<div className="flex gap-2">{onTest && <button type="button" onClick={() => void test()} disabled={testing || saving || !baseUrl.trim() || !model.trim()} aria-label="Test Guardian connection" className="px-3 py-2 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-sm text-slate-200">{testing ? 'Testing…' : 'Test'}</button>}<button type="button" onClick={() => void save()} disabled={saving || partiallyConfigured} aria-label="Save Guardian settings" className="flex-1 py-2 rounded bg-purple-600 hover:bg-purple-500 disabled:bg-slate-600 text-sm text-white">{saving ? 'Saving…' : baseUrl.trim() || model.trim() ? 'Save Guardian settings' : 'Disable Guardian'}</button></div></div></div>;
}

function OpenCodeGroup({ title, count, empty, children, collapsible = false }: { title: string; count: number; empty: string; children: ReactNode; collapsible?: boolean }) {
  const body = count === 0 ? <><p className="px-3 py-2.5 text-xs text-slate-500">{empty}</p>{children}</> : <div className="divide-y divide-slate-700/40">{children}</div>;
  if (collapsible) return <details className="group rounded-lg bg-slate-700/30 overflow-hidden"><summary className="flex items-center justify-between px-3 py-2 cursor-pointer list-none border-b border-slate-700/50"><span className="flex items-center gap-1.5"><svg className="w-3 h-3 text-slate-500 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg><span className="text-xs font-medium text-slate-300">{title}</span></span><span className="text-[11px] text-slate-500">{count}</span></summary>{body}</details>;
  return <div className="rounded-lg bg-slate-700/30 overflow-hidden"><div className="flex items-center justify-between px-3 py-2 border-b border-slate-700/50"><span className="text-xs font-medium text-slate-300">{title}</span><span className="text-[11px] text-slate-500">{count}</span></div>{body}</div>;
}

function OpenCodeRow({ title, detail, onClick }: { title: string; detail?: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="w-full px-3 py-2 text-left hover:bg-slate-700/50 transition-colors"><div className="flex items-start gap-2"><div className="flex-1 min-w-0"><p className="text-xs text-slate-200 font-mono break-all">{title}</p>{detail && <p className="mt-0.5 text-[11px] text-slate-500 break-all">{detail}</p>}</div><svg className="w-3.5 h-3.5 mt-0.5 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg></div></button>;
}

function OpenCodeDetailModal({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4" role="dialog" aria-modal="true" aria-label={`${detail.kind} details`} onMouseDown={onClose}>
    <div className="w-full max-w-md max-h-[80vh] overflow-y-auto rounded-t-xl sm:rounded-xl bg-slate-800 border border-slate-700 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
      <div className="flex items-start justify-between gap-3 p-4 border-b border-slate-700"><div className="min-w-0"><p className="text-[11px] uppercase tracking-wide text-slate-500">{detail.kind}</p><h2 className="mt-1 text-sm font-medium text-white font-mono break-all">{detail.title}</h2></div><button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-white" aria-label="Close details">×</button></div>
      <dl className="divide-y divide-slate-700/60">{detail.rows.map(([label, value]) => <div key={label} className="px-4 py-3"><dt className="text-[11px] text-slate-500">{label}</dt><dd className="mt-1 text-xs text-slate-200 font-mono whitespace-pre-wrap break-all">{value}</dd></div>)}</dl>
    </div>
  </div>;
}

function McpEditor({ onClose, onSave }: {
  onClose: () => void;
  onSave: (name: string, config: { type: 'local' | 'remote'; command?: string[]; url?: string; headers?: Record<string, string> }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'local' | 'remote'>('remote');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [headerName, setHeaderName] = useState('Authorization');
  const [headerValue, setHeaderValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true); setError(null);
    try {
      const config = type === 'local'
        ? { type, command: command.trim().split(/\s+/).filter(Boolean) }
        : { type, url: url.trim(), ...(headerValue ? { headers: { [headerName.trim() || 'Authorization']: headerValue } } : {}) };
      await onSave(name.trim(), config);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to save MCP'); }
    finally { setSaving(false); }
  };
  return <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4" role="dialog" aria-modal="true"><div className="w-full max-w-md rounded-t-xl sm:rounded-xl bg-slate-800 border border-slate-700 p-4 space-y-3"><div className="flex justify-between"><h2 className="text-sm font-medium text-white">Add MCP</h2><button type="button" onClick={onClose} className="text-slate-400 hover:text-white">×</button></div><label className="block text-xs text-slate-400">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. github" className="mt-1 w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white" /></label><div className="flex gap-2"><button type="button" onClick={() => setType('remote')} className={`px-3 py-1.5 rounded text-xs ${type === 'remote' ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-300'}`}>Remote</button><button type="button" onClick={() => setType('local')} className={`px-3 py-1.5 rounded text-xs ${type === 'local' ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-300'}`}>Local</button></div>{type === 'remote' ? <><label className="block text-xs text-slate-400">URL<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="mt-1 w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white" /></label><label className="block text-xs text-slate-400">Optional header name<input value={headerName} onChange={(e) => setHeaderName(e.target.value)} className="mt-1 w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white" /></label><label className="block text-xs text-slate-400">Optional header value<MaskedSecretInput value={headerValue} onChange={setHeaderValue} placeholder="Leave blank when not needed" /></label></> : <label className="block text-xs text-slate-400">Command<input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y …" className="mt-1 w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white font-mono" /></label>}{error && <p className="text-xs text-red-300">{error}</p>}<button type="button" onClick={() => void save()} disabled={saving || !name.trim() || (type === 'remote' ? !url.trim() : !command.trim())} className="w-full py-2 rounded bg-purple-600 hover:bg-purple-500 disabled:bg-slate-600 text-sm text-white">{saving ? 'Saving…' : 'Save & Test'}</button></div></div>;
}
