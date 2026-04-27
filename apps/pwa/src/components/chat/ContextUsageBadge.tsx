import { useState, useEffect } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { clsx } from 'clsx';
import type { ContextUsageBreakdown } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../../stores/claudeStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { useSessionConfig } from '../../hooks/useSessionConfig';
import { getModelContextLimit } from '../../lib/claudePresets';

interface ContextUsageBadgeProps {
  sessionId: string;
  onCompact?: () => void;
  onClear?: () => void;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}

function formatPct(value: number, total: number): string {
  if (total <= 0) return '0%';
  const p = (value / total) * 100;
  return p < 10 ? p.toFixed(1) + '%' : Math.round(p) + '%';
}

// Maps CLI "color" tokens to tailwind fill classes. `promptBorder`/`inactive`
// variants are muted since they typically denote fixed/free/buffer regions.
const CATEGORY_COLOR: Record<string, { fill: string; dot: string }> = {
  promptBorder: { fill: 'bg-slate-500', dot: 'bg-slate-500' },
  inactive:     { fill: 'bg-zinc-500',  dot: 'bg-zinc-500' },
  claude:       { fill: 'bg-sky-500',   dot: 'bg-sky-500' },
  warning:      { fill: 'bg-amber-500', dot: 'bg-amber-500' },
  purple_FOR_SUBAGENTS_ONLY: { fill: 'bg-violet-500', dot: 'bg-violet-500' },
};

function colorFor(name: string): { fill: string; dot: string } {
  return CATEGORY_COLOR[name] ?? { fill: 'bg-slate-500', dot: 'bg-slate-500' };
}

export function ContextUsageBadge({ sessionId, onCompact, onClear }: ContextUsageBadgeProps) {
  const intl = useIntl();
  const session = useClaudeStore((s) => s.sessions[sessionId]);
  const config = useSessionConfig(sessionId);
  const [open, setOpen] = useState(false);

  const breakdown = session?.lastTurnContextUsage as ContextUsageBreakdown | undefined;
  const modelFromBreakdown = breakdown?.model;
  const modelFromConfig = config.model as string | undefined;
  const model = modelFromBreakdown ?? modelFromConfig;
  const codexModels = useConnectionStore((s) => s.codexModels);
  // Prefer the session's own contextWindow over the model-derived default —
  // a Sonnet session set to 200k should show /200k, not /1M.
  const sessionContextWindow = config.contextWindow as number | undefined;
  const fallbackLimit = getModelContextLimit(modelFromConfig, codexModels, sessionContextWindow);

  // Fallback (raw turn tokens) — used when breakdown not yet available.
  const input = session?.lastTurnInputTokens ?? 0;
  const cacheCreation = session?.lastTurnCacheCreationTokens ?? 0;
  const cacheRead = session?.lastTurnCacheReadTokens ?? 0;
  const rawUsed = input + cacheCreation + cacheRead;

  const used = breakdown?.totalTokens ?? rawUsed;
  // Prefer the user's selected contextWindow over breakdown.maxTokens.
  // Why: changing the chip only triggers a cold-resume on the NEXT prompt
  // (sessionManager.resumeSession), so until then breakdown.maxTokens still
  // reports the previous window the running CLI was spawned with. Showing
  // the user's pick keeps the chip and badge in sync with their intent.
  const limit = sessionContextWindow ?? breakdown?.maxTokens ?? fallbackLimit;

  const turnCount = session?.turnCount ?? 0;
  const totalInput = session?.totalInputTokens ?? 0;
  const totalOutput = session?.totalOutputTokens ?? 0;
  const totalCost = session?.totalCostUsd ?? 0;

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  if (used === 0) return null;

  const pct = Math.min(100, (used / limit) * 100);
  const pctLabel = pct < 10 ? pct.toFixed(1) : Math.round(pct).toString();
  const chipTone =
    pct >= 90 ? 'bg-rose-600/20 text-rose-400 hover:bg-rose-600/30'
    : pct >= 70 ? 'bg-amber-600/20 text-amber-400 hover:bg-amber-600/30'
    : 'bg-slate-700/60 text-slate-400 hover:bg-slate-700 hover:text-slate-300';

  const tone =
    pct >= 90 ? 'text-rose-400'
    : pct >= 70 ? 'text-amber-400'
    : 'text-slate-400';

  const barTone =
    pct >= 90 ? 'bg-rose-500'
    : pct >= 70 ? 'bg-amber-500'
    : 'bg-blue-500';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={intl.formatMessage(
          { id: 'contextUsage.badgeTitle' },
          { used: formatTokens(used), limit: formatTokens(limit) },
        )}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 rounded-md tabular-nums transition-colors',
          chipTone,
        )}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h10" />
        </svg>
        {pctLabel}%
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onPointerDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl w-full max-w-sm p-5 space-y-5 max-h-[90vh] overflow-y-auto">
            {/* Header */}
            <div>
              <h3 className="text-sm font-medium text-slate-200">
                <FormattedMessage id="contextUsage.title" />
              </h3>
              {model && (
                <p className="text-xs text-slate-500 mt-0.5 font-mono">{model}</p>
              )}
            </div>

            {/* Usage bar */}
            <div>
              <div className="flex items-baseline justify-between mb-1.5 text-xs">
                <span className="text-slate-400">
                  <span className="tabular-nums text-slate-200 font-medium">{formatTokens(used)}</span>
                  <span className="text-slate-600 mx-1">/</span>
                  <span className="tabular-nums">{formatTokens(limit)}</span>
                </span>
                <span className={clsx('tabular-nums font-medium', tone)}>{pctLabel}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-700 overflow-hidden">
                <div className={clsx('h-full transition-all', barTone)} style={{ width: `${pct}%` }} />
              </div>
              {breakdown?.isAutoCompactEnabled && breakdown.autoCompactThreshold && (
                <p className="text-[10px] text-slate-500 mt-1">
                  <FormattedMessage
                    id="contextUsage.autoCompactHint"
                    values={{ tokens: formatTokens(breakdown.autoCompactThreshold) }}
                  />
                </p>
              )}
            </div>

            {breakdown ? (
              <>
                {/* Categories — the rich breakdown from the CLI */}
                <CategoriesSection breakdown={breakdown} />

                {/* Message breakdown — what fills the "Messages" bucket */}
                {breakdown.messageBreakdown && (
                  <MessageBreakdownSection breakdown={breakdown.messageBreakdown} />
                )}

                {/* Memory files */}
                {breakdown.memoryFiles && breakdown.memoryFiles.length > 0 && (
                  <DetailList
                    title={intl.formatMessage({ id: 'contextUsage.section.memoryFiles' })}
                    items={breakdown.memoryFiles.map((f) => ({
                      key: f.path,
                      primary: f.path.split('/').pop() ?? f.path,
                      secondary: f.type,
                      tokens: f.tokens,
                    }))}
                  />
                )}

                {/* MCP tools — grouped by server */}
                {breakdown.mcpTools && breakdown.mcpTools.length > 0 && (
                  <McpToolsSection tools={breakdown.mcpTools} />
                )}

                {/* Skills */}
                {breakdown.skills && breakdown.skills.skillFrontmatter && breakdown.skills.skillFrontmatter.length > 0 && (
                  <DetailList
                    title={intl.formatMessage(
                      { id: 'contextUsage.section.skills' },
                      { included: breakdown.skills.includedSkills, total: breakdown.skills.totalSkills },
                    )}
                    subtitle={intl.formatMessage(
                      { id: 'contextUsage.section.skillsSubtitle' },
                      { tokens: formatTokens(breakdown.skills.tokens) },
                    )}
                    items={breakdown.skills.skillFrontmatter.map((s) => ({
                      key: s.name + ':' + s.source,
                      primary: s.name,
                      secondary: s.source,
                      tokens: s.tokens,
                    }))}
                  />
                )}
              </>
            ) : (
              /* Fallback — raw turn tokens only, no CLI breakdown yet */
              <FallbackSection input={input} cacheCreation={cacheCreation} cacheRead={cacheRead} used={rawUsed} />
            )}

            {/* Session totals */}
            {turnCount > 0 && (
              <section>
                <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
                  <FormattedMessage id="contextUsage.section.sessionTotals" />
                </h4>
                <div className="space-y-1.5 text-xs">
                  <StatRow label={intl.formatMessage({ id: 'contextUsage.totals.turns' })} value={String(turnCount)} />
                  <StatRow label={intl.formatMessage({ id: 'contextUsage.totals.input' })} value={formatTokens(totalInput)} />
                  <StatRow label={intl.formatMessage({ id: 'contextUsage.totals.output' })} value={formatTokens(totalOutput)} />
                  {totalCost > 0 && (
                    <StatRow
                      label={intl.formatMessage({ id: 'contextUsage.totals.cost' })}
                      value={'$' + totalCost.toFixed(totalCost < 0.01 ? 4 : 2)}
                    />
                  )}
                </div>
              </section>
            )}

            {/* Actions */}
            <div className="space-y-2 pt-1">
              {(onCompact || onClear) && (
                <div className="grid grid-cols-2 gap-2">
                  {onCompact && (
                    <button
                      type="button"
                      onClick={() => { onCompact(); setOpen(false); }}
                      className="px-3 py-2 text-xs font-medium rounded-md bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
                      title={intl.formatMessage({ id: 'contextUsage.action.compactTitle' })}
                    >
                      <FormattedMessage id="contextUsage.action.compact" />
                    </button>
                  )}
                  {onClear && (
                    <button
                      type="button"
                      onClick={() => { onClear(); setOpen(false); }}
                      className="px-3 py-2 text-xs font-medium rounded-md bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
                      title={intl.formatMessage({ id: 'contextUsage.action.clearTitle' })}
                    >
                      <FormattedMessage id="contextUsage.action.clear" />
                    </button>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-full px-3 py-2.5 text-xs font-medium rounded-md bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white shadow-md shadow-blue-900/40 hover:shadow-lg hover:shadow-blue-900/50 transition-all"
              >
                <FormattedMessage id="contextUsage.action.close" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CategoriesSection({ breakdown }: { breakdown: ContextUsageBreakdown }) {
  const total = breakdown.totalTokens + (breakdown.categories.find((c) => c.name === 'Free space')?.tokens ?? 0);
  // Denominator = maxTokens so each category's width reflects share of the whole window.
  const denom = Math.max(breakdown.maxTokens, total, 1);
  const segments = breakdown.categories.map((c) => ({
    value: c.tokens,
    color: colorFor(c.color).fill,
    label: c.name,
  }));
  return (
    <section>
      <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
        <FormattedMessage id="contextUsage.section.byCategory" />
      </h4>
      <div className="h-2.5 rounded-full bg-slate-900/60 overflow-hidden flex">
        {segments.map((seg, idx) =>
          seg.value > 0 ? (
            <div
              key={idx}
              className={clsx('h-full', seg.color)}
              style={{ width: `${(seg.value / denom) * 100}%` }}
              title={`${seg.label}: ${formatTokens(seg.value)}`}
            />
          ) : null,
        )}
      </div>
      <div className="space-y-1 mt-3 text-xs">
        {breakdown.categories.map((c) => (
          <div key={c.name} className="flex items-center gap-2">
            <span className={clsx('w-2 h-2 rounded-sm shrink-0', colorFor(c.color).dot)} />
            <span className={clsx('flex-1', c.isDeferred ? 'text-slate-500 italic' : 'text-slate-400')}>
              {c.name}
            </span>
            <span className="tabular-nums text-slate-300">{formatTokens(c.tokens)}</span>
            <span className="tabular-nums text-slate-500 w-10 text-right">
              {formatPct(c.tokens, breakdown.maxTokens)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MessageBreakdownSection({
  breakdown,
}: {
  breakdown: NonNullable<ContextUsageBreakdown['messageBreakdown']>;
}) {
  const intl = useIntl();
  const rows: Array<{ key: string; label: string; color: string; value: number }> = [
    { key: 'tool_calls', label: intl.formatMessage({ id: 'contextUsage.message.toolCalls' }), color: 'bg-blue-500', value: breakdown.toolCallTokens },
    { key: 'tool_results', label: intl.formatMessage({ id: 'contextUsage.message.toolResults' }), color: 'bg-emerald-500', value: breakdown.toolResultTokens },
    { key: 'assistant', label: intl.formatMessage({ id: 'contextUsage.message.assistant' }), color: 'bg-violet-500', value: breakdown.assistantMessageTokens },
    { key: 'user', label: intl.formatMessage({ id: 'contextUsage.message.user' }), color: 'bg-sky-500', value: breakdown.userMessageTokens },
    { key: 'attachments', label: intl.formatMessage({ id: 'contextUsage.message.attachments' }), color: 'bg-amber-500', value: breakdown.attachmentTokens },
    ...(breakdown.unattributedTokens
      ? [{ key: 'unattributed', label: intl.formatMessage({ id: 'contextUsage.message.unattributed' }), color: 'bg-slate-500', value: breakdown.unattributedTokens }]
      : []),
  ].filter((r) => r.value > 0);
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  if (total <= 0) return null;

  return (
    <section>
      <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
        <FormattedMessage id="contextUsage.section.insideMessages" values={{ tokens: formatTokens(total) }} />
      </h4>
      <div className="h-2.5 rounded-full bg-slate-900/60 overflow-hidden flex">
        {rows.map((r) => (
          <div
            key={r.key}
            className={clsx('h-full', r.color)}
            style={{ width: `${(r.value / total) * 100}%` }}
            title={`${r.label}: ${formatTokens(r.value)}`}
          />
        ))}
      </div>
      <div className="space-y-1 mt-3 text-xs">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2">
            <span className={clsx('w-2 h-2 rounded-sm shrink-0', r.color)} />
            <span className="text-slate-400 flex-1">{r.label}</span>
            <span className="tabular-nums text-slate-300">{formatTokens(r.value)}</span>
            <span className="tabular-nums text-slate-500 w-10 text-right">{formatPct(r.value, total)}</span>
          </div>
        ))}
      </div>

      {breakdown.toolCallsByType && breakdown.toolCallsByType.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-700/50">
          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
            <FormattedMessage id="contextUsage.byTool" />
          </p>
          <div className="space-y-1 text-xs">
            {breakdown.toolCallsByType.map((t) => (
              <div key={t.name} className="flex items-baseline justify-between gap-2">
                <span className="text-slate-300 font-mono text-[11px] truncate">{t.name}</span>
                <span className="tabular-nums text-slate-500 text-[11px] shrink-0">
                  {formatTokens(t.callTokens)} <span className="text-slate-600">→</span>{' '}
                  <span className="text-slate-300">{formatTokens(t.resultTokens)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {breakdown.attachmentsByType && breakdown.attachmentsByType.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-700/50">
          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
            <FormattedMessage id="contextUsage.attachments" />
          </p>
          <div className="space-y-1 text-xs">
            {breakdown.attachmentsByType.map((a) => (
              <div key={a.name} className="flex items-baseline justify-between gap-2">
                <span className="text-slate-300 font-mono text-[11px] truncate">{a.name}</span>
                <span className="tabular-nums text-slate-400 text-[11px]">{formatTokens(a.tokens)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function McpToolsSection({ tools }: { tools: NonNullable<ContextUsageBreakdown['mcpTools']> }) {
  // Group by server, summing tokens and splitting loaded/deferred.
  const byServer = new Map<string, { loaded: number; deferred: number; loadedCount: number; deferredCount: number }>();
  for (const t of tools) {
    const entry = byServer.get(t.serverName) ?? { loaded: 0, deferred: 0, loadedCount: 0, deferredCount: 0 };
    if (t.isLoaded) {
      entry.loaded += t.tokens;
      entry.loadedCount += 1;
    } else {
      entry.deferred += t.tokens;
      entry.deferredCount += 1;
    }
    byServer.set(t.serverName, entry);
  }
  const totalTokens = tools.reduce((sum, t) => sum + t.tokens, 0);

  return (
    <section>
      <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
        <FormattedMessage id="contextUsage.section.mcpTools" values={{ tokens: formatTokens(totalTokens) }} />
      </h4>
      <div className="space-y-1 text-xs">
        {Array.from(byServer.entries()).map(([server, info]) => (
          <div key={server} className="flex items-baseline justify-between gap-2">
            <span className="text-slate-300 font-mono text-[11px] truncate">{server}</span>
            <span className="tabular-nums text-slate-500 text-[11px] shrink-0">
              <FormattedMessage
                id="contextUsage.toolCount"
                values={{ count: info.loadedCount + info.deferredCount }}
              />
              <span className="mx-1 text-slate-600">·</span>
              <span className="text-slate-300">{formatTokens(info.loaded + info.deferred)}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DetailList({
  title,
  subtitle,
  items,
}: {
  title: string;
  subtitle?: string;
  items: Array<{ key: string; primary: string; secondary?: string; tokens: number }>;
}) {
  return (
    <section>
      <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2 flex items-baseline justify-between">
        <span>{title}</span>
        {subtitle && <span className="text-slate-600 font-normal normal-case tracking-normal">{subtitle}</span>}
      </h4>
      <div className="space-y-1 text-xs">
        {items.map((it) => (
          <div key={it.key} className="flex items-baseline justify-between gap-2">
            <span className="text-slate-300 truncate">
              {it.primary}
              {it.secondary && <span className="text-slate-500 ml-1.5">· {it.secondary}</span>}
            </span>
            <span className="tabular-nums text-slate-400 text-[11px] shrink-0">{formatTokens(it.tokens)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function FallbackSection({
  input,
  cacheCreation,
  cacheRead,
  used,
}: {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  used: number;
}) {
  const intl = useIntl();
  return (
    <section>
      <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
        <FormattedMessage id="contextUsage.section.currentTurn" values={{ tokens: formatTokens(used) }} />
      </h4>
      <div className="h-2.5 rounded-full bg-slate-900/60 overflow-hidden flex">
        {[
          { v: cacheRead, c: 'bg-emerald-500' },
          { v: cacheCreation, c: 'bg-sky-500' },
          { v: input, c: 'bg-amber-500' },
        ].map((s, idx) =>
          s.v > 0 ? (
            <div
              key={idx}
              className={clsx('h-full', s.c)}
              style={{ width: `${(s.v / Math.max(used, 1)) * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <div className="space-y-1 mt-3 text-xs">
        <LegendRow color="bg-emerald-500" label={intl.formatMessage({ id: 'contextUsage.fallback.cacheRead' })} value={cacheRead} total={used} />
        <LegendRow color="bg-sky-500" label={intl.formatMessage({ id: 'contextUsage.fallback.cacheCreated' })} value={cacheCreation} total={used} />
        <LegendRow color="bg-amber-500" label={intl.formatMessage({ id: 'contextUsage.fallback.inputBilled' })} value={input} total={used} />
      </div>
      <p className="text-[10px] text-slate-500 mt-2 italic">
        <FormattedMessage id="contextUsage.fallback.laterHint" />
      </p>
    </section>
  );
}

function LegendRow({
  color,
  label,
  value,
  total,
}: {
  color: string;
  label: string;
  value: number;
  total: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={clsx('w-2 h-2 rounded-sm shrink-0', color)} />
      <span className="text-slate-400 flex-1">{label}</span>
      <span className="tabular-nums text-slate-300">{formatTokens(value)}</span>
      <span className="tabular-nums text-slate-500 w-10 text-right">
        {formatPct(value, total)}
      </span>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-slate-400">{label}</span>
      <span className="tabular-nums text-slate-200">{value}</span>
    </div>
  );
}
