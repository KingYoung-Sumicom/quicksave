import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import type { SessionControlRequestResponsePayload } from '@sumicom/quicksave-shared';

type SendControlRequest = (
  sessionId: string,
  subtype: string,
  params?: Record<string, unknown>,
) => Promise<SessionControlRequestResponsePayload>;

interface ParamField {
  name: string;
  placeholder?: string;
  required?: boolean;
}

interface ControlRequestDef {
  subtype: string;
  label: string;
  description: string;
  params?: ParamField[];
  /** Transform raw string inputs into the params object sent to the agent. */
  buildParams?: (raw: Record<string, string>) => Record<string, unknown>;
}

const CONTROL_REQUESTS: ControlRequestDef[] = [
  {
    subtype: 'get_context_usage',
    label: 'Get Context Usage',
    description: 'Show breakdown of context window usage by category',
  },
  {
    subtype: 'get_settings',
    label: 'Get Settings',
    description: 'Show effective merged settings and raw per-source settings',
  },
  {
    subtype: 'set_model',
    label: 'Set Model',
    description: 'Switch the model for the current task (no restart)',
    params: [{ name: 'model', placeholder: 'claude-opus-4-7[1m]', required: true }],
  },
  {
    subtype: 'set_permission_mode',
    label: 'Set Permission Mode',
    description: 'Change permission mode (default, acceptEdits, bypassPermissions, plan, dontAsk, auto)',
    params: [{ name: 'mode', placeholder: 'acceptEdits', required: true }],
  },
  {
    subtype: 'set_max_thinking_tokens',
    label: 'Set Max Thinking Tokens',
    description: 'Set the thinking token budget',
    params: [{ name: 'tokens', placeholder: '8000', required: true }],
    buildParams: (raw) => ({ tokens: Number(raw.tokens) }),
  },
  {
    subtype: 'interrupt',
    label: 'Interrupt',
    description: 'Interrupt the currently running turn',
  },
  {
    subtype: 'mcp_status',
    label: 'MCP Status',
    description: 'Report status of MCP servers',
  },
  {
    subtype: 'reload_plugins',
    label: 'Reload Plugins',
    description: 'Reload plugins, commands, agents, MCP servers from disk',
  },
];

interface ControlRequestPaletteProps {
  sessionId: string | null;
  onSendControlRequest?: SendControlRequest;
}

export function ControlRequestPalette({ sessionId, onSendControlRequest }: ControlRequestPaletteProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ subtype: string; data: unknown; error?: string } | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CONTROL_REQUESTS;
    return CONTROL_REQUESTS.filter(
      (r) =>
        r.subtype.toLowerCase().includes(q) ||
        r.label.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q),
    );
  }, [query]);

  const selectedDef = CONTROL_REQUESTS.find((r) => r.subtype === selected);
  const disabled = !sessionId || !onSendControlRequest;

  const handleSend = async () => {
    if (!sessionId || !onSendControlRequest || !selectedDef) return;

    // Validate required params
    if (selectedDef.params) {
      for (const p of selectedDef.params) {
        if (p.required && !paramValues[p.name]?.trim()) {
          setResult({ subtype: selectedDef.subtype, data: null, error: `Missing required param: ${p.name}` });
          return;
        }
      }
    }

    const params = selectedDef.buildParams
      ? selectedDef.buildParams(paramValues)
      : selectedDef.params?.reduce<Record<string, unknown>>((acc, p) => {
        if (paramValues[p.name]?.trim()) acc[p.name] = paramValues[p.name];
        return acc;
      }, {});

    setIsSending(true);
    setResult(null);
    setCopied(false);
    try {
      const resp = await onSendControlRequest(sessionId, selectedDef.subtype, params);
      setResult({
        subtype: selectedDef.subtype,
        data: resp.response,
        error: resp.success ? undefined : resp.error,
      });
    } catch (err) {
      setResult({
        subtype: selectedDef.subtype,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="space-y-3">
      {disabled && (
        <p className="text-xs text-slate-500">
          {!sessionId ? 'Requires an active task.' : 'Control request API not available.'}
        </p>
      )}

      {/* Search input */}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search control requests..."
        className="w-full bg-slate-700 border border-slate-600 rounded-md px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        disabled={disabled}
      />

      {/* List */}
      <div className="max-h-64 overflow-y-auto rounded-md border border-slate-700">
        {filtered.length === 0 ? (
          <p className="p-3 text-xs text-slate-500">No matches</p>
        ) : (
          filtered.map((r) => (
            <button
              key={r.subtype}
              type="button"
              onClick={() => {
                setSelected(r.subtype);
                setParamValues({});
                setResult(null);
              }}
              disabled={disabled}
              className={clsx(
                'w-full text-left px-3 py-2 border-b border-slate-700 last:border-b-0 transition-colors',
                selected === r.subtype
                  ? 'bg-blue-600/20 text-blue-300'
                  : 'text-slate-300 hover:bg-slate-700 disabled:hover:bg-transparent disabled:opacity-50',
              )}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-slate-400">{r.subtype}</span>
                <span className="text-sm">{r.label}</span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">{r.description}</p>
            </button>
          ))
        )}
      </div>

      {/* Parameter inputs for selected request */}
      {selectedDef && (
        <div className="space-y-2 p-3 bg-slate-800/50 border border-slate-700 rounded-md">
          <div className="text-xs font-semibold text-slate-300 font-mono">{selectedDef.subtype}</div>

          {selectedDef.params?.map((p) => (
            <div key={p.name}>
              <label className="block text-xs text-slate-400 mb-1">
                {p.name}
                {p.required && <span className="text-red-400 ml-1">*</span>}
              </label>
              <input
                type="text"
                value={paramValues[p.name] ?? ''}
                onChange={(e) => setParamValues({ ...paramValues, [p.name]: e.target.value })}
                placeholder={p.placeholder}
                className="w-full bg-slate-700 border border-slate-600 rounded-md px-2 py-1 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
              />
            </div>
          ))}

          <button
            type="button"
            onClick={handleSend}
            disabled={disabled || isSending}
            className="w-full py-1.5 px-3 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-md text-sm font-medium text-white transition-colors"
          >
            {isSending ? 'Sending...' : 'Send'}
          </button>
        </div>
      )}

      {/* Response display */}
      {result && (
        <div className="p-3 bg-slate-900 border border-slate-700 rounded-md">
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs text-slate-400">
              Response from <span className="font-mono">{result.subtype}</span>
            </div>
            <button
              type="button"
              onClick={async () => {
                const text = result.error ?? JSON.stringify(result.data, null, 2);
                try {
                  await navigator.clipboard.writeText(text);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* clipboard may be unavailable over http */
                }
              }}
              className="text-xs text-slate-400 hover:text-slate-200 px-2 py-0.5 rounded border border-slate-700 hover:border-slate-500 transition-colors"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {result.error ? (
            <pre className="text-xs text-red-400 font-mono whitespace-pre-wrap break-all">{result.error}</pre>
          ) : (
            <pre className="text-xs text-slate-300 font-mono whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
              {JSON.stringify(result.data, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
