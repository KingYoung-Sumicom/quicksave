// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import type { AgentId, AgentCapabilities, CodexModelInfo } from '@sumicom/quicksave-shared';
import { DEFAULT_CONTEXT_WINDOW } from '@sumicom/quicksave-shared';
import {
  CLAUDE_MODELS,
  CLAUDE_CONTEXT_WINDOWS,
  PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  OPENCODE_PERMISSION_MODES,
  REASONING_EFFORTS_CLAUDE,
  REASONING_EFFORTS_CODEX_FALLBACK,
  CODEX_MODELS_FALLBACK,
  getContextWindowOptionsForModel,
  clampContextWindowForModel,
  getModelContextLimit as getPresetModelContextLimit,
  codexModelsToOptions,
  type AgentType,
} from './claudePresets';
import { ButtonGroup } from '../components/ui/ButtonGroup';
import { ToggleSwitch } from '../components/ui/ToggleSwitch';
import { clsx } from 'clsx';

// ── Public types ─────────────────────────────────────────────────────────────

export type Option = { value: string; label: string };

export type SettingKind =
  | { kind: 'preset'; options: ReadonlyArray<Option> }
  | { kind: 'boolean' }
  | { kind: 'range'; min: number; max: number; step: number }
  | { kind: 'text'; placeholder?: string };

export interface SettingDescriptor {
  key: string;
  label: string;
  setting: SettingKind;
  default: unknown;
  /** Hidden in new-session UI; only shown in active-session settings. */
  sessionOnly?: boolean;
}

export interface AgentDynamicData {
  codexModels?: CodexModelInfo[];
  opencodeModels?: Array<{ id: string; name: string }>;
}

export interface RenderSettingsOpts {
  mode: 'new-session' | 'active-session';
  dynamic?: AgentDynamicData;
  /** Keys to skip rendering (e.g. already shown in status bar). */
  hideKeys?: string[];
  /** sessionId — used by some agents for active-session hints. */
  sessionId?: string | null;
  /** Whether the user has opted into billed 1M context (Sonnet today). When
   *  false, Sonnet's contextWindow options collapse to 200k. */
  allow1mForBilledModels?: boolean;
}

export interface RenderChipsOpts {
  dynamic?: AgentDynamicData;
  openPopover: string | null;
  onOpenPopover: (key: string | null) => void;
  /** Same opt-in as RenderSettingsOpts.allow1mForBilledModels. */
  allow1mForBilledModels?: boolean;
}

export interface AgentProvider {
  readonly id: AgentId;
  readonly label: string;
  readonly description: string;
  readonly allowedTools?: string[];
  readonly systemPrompt?: string;
  readonly capabilities: AgentCapabilities;
  readonly features: ReadonlyArray<string>;
  readonly defaultModel: string;
  readonly defaultPermissionMode: string;
  readonly defaultReasoningEffort: string;

  /** Ordered setting descriptors this agent exposes. */
  getSettings(dynamic?: AgentDynamicData): ReadonlyArray<SettingDescriptor>;

  /** Available model options. Empty = hide model picker. */
  getModels(dynamic?: AgentDynamicData): ReadonlyArray<Option>;

  /** Clamp a setting to what the given model supports.
   *  Returns value unchanged if not applicable. */
  clampSetting(key: string, value: unknown, model?: string): unknown;

  /** Effective context window ceiling for the usage progress bar. */
  getModelContextLimit(model?: string, dynamic?: AgentDynamicData, sessionCtxWindow?: number): number;

  /** Render settings controls for new-session page or active-session drawer.
   *  `values` map includes 'model' plus all setting keys. */
  renderSettings(
    values: Record<string, unknown>,
    onChange: (key: string, value: unknown) => void,
    opts: RenderSettingsOpts,
  ): React.ReactNode[];

  /** Render the status-bar chips for an active session. */
  renderStatusChips(
    values: Record<string, unknown>,
    onChange: (key: string, value: unknown) => void,
    opts: RenderChipsOpts,
  ): React.ReactNode[];

  /** Render advanced/secondary panel in the session sidebar. null = nothing. */
  renderSidebarAdvanced(
    values: Record<string, unknown>,
    onChange: (key: string, value: unknown) => void,
    dynamic?: AgentDynamicData,
  ): React.ReactNode | null;
}

// ── Shared internal components ────────────────────────────────────────────────

function StatusChipButton({
  chipKey,
  icon,
  label,
  open,
  onOpen,
  active,
  onToggle,
  options,
  currentValue,
  onSelect,
}: {
  chipKey: string;
  icon?: React.ReactNode;
  label: string;
  /** If true, chip is a simple toggle (no dropdown). */
  open?: boolean;
  onOpen?: () => void;
  active?: boolean;
  onToggle?: () => void;
  options?: ReadonlyArray<Option>;
  currentValue?: string;
  onSelect?: (value: string) => void;
}) {
  if (onToggle) {
    return (
      <button
        key={chipKey}
        type="button"
        onClick={onToggle}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 rounded-md transition-colors text-xs',
          active
            ? 'bg-emerald-600/20 text-emerald-400'
            : 'bg-slate-700/60 text-slate-400 hover:bg-slate-700 hover:text-slate-300',
        )}
      >
        {icon}
        {label}
      </button>
    );
  }

  return (
    <>
      <button
        key={chipKey}
        type="button"
        onClick={onOpen}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 rounded-md transition-colors text-xs',
          open
            ? 'bg-blue-600/20 text-blue-400'
            : 'bg-slate-700/60 text-slate-400 hover:bg-slate-700 hover:text-slate-300',
        )}
      >
        {icon}
        {label}
        <svg className="w-2.5 h-2.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && options && (
        <div className="absolute bottom-full left-0 mb-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl py-1 min-w-[180px] z-50">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onSelect?.(o.value)}
              className={clsx(
                'w-full text-left px-3 py-1.5 text-xs transition-colors',
                o.value === currentValue
                  ? 'bg-blue-600/20 text-blue-400'
                  : 'text-slate-300 hover:bg-slate-700',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function SandboxSettingControl({
  enabled,
  onChange,
  compact,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
  compact?: boolean;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <div className="space-y-2">
      <ToggleSwitch
        label={compact ? 'Sandbox' : undefined}
        description={compact ? undefined : 'Restrict writes to project directory'}
        enabled={enabled}
        onChange={onChange}
        compact={compact}
      />
      <button
        type="button"
        onClick={() => setHelpOpen((v) => !v)}
        aria-expanded={helpOpen}
        className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <FormattedMessage id="newSession.sandbox.help.toggle" defaultMessage="What does this do?" />
      </button>
      {helpOpen && (
        <div className="text-[11px] text-slate-400 space-y-1.5 rounded-md border border-slate-700/60 bg-slate-900/40 p-2.5">
          <p className="font-semibold text-slate-300">
            <FormattedMessage id="newSession.sandbox.help.title" defaultMessage="About sandbox mode" />
          </p>
          <p>
            <span className="text-emerald-400 font-medium">
              <FormattedMessage id="newSession.sandbox.help.onLabel" defaultMessage="On (recommended):" />
            </span>{' '}
            <FormattedMessage id="newSession.sandbox.help.onBody" defaultMessage="Adds a SandboxBash MCP tool." />
          </p>
          <p>
            <span className="text-amber-400 font-medium">
              <FormattedMessage id="newSession.sandbox.help.offLabel" defaultMessage="Off:" />
            </span>{' '}
            <FormattedMessage id="newSession.sandbox.help.offBody" defaultMessage="Removes SandboxBash." />
          </p>
        </div>
      )}
    </div>
  );
}

// ── Base class ────────────────────────────────────────────────────────────────

abstract class BaseAgentProvider implements AgentProvider {
  abstract readonly id: AgentId;
  abstract readonly label: string;
  abstract readonly description: string;
  abstract readonly capabilities: AgentCapabilities;
  abstract readonly features: ReadonlyArray<string>;
  abstract readonly defaultModel: string;
  abstract readonly defaultPermissionMode: string;
  abstract readonly defaultReasoningEffort: string;

  readonly allowedTools?: string[];
  readonly systemPrompt?: string;

  abstract getSettings(dynamic?: AgentDynamicData): ReadonlyArray<SettingDescriptor>;
  abstract getModels(dynamic?: AgentDynamicData): ReadonlyArray<Option>;

  clampSetting(_key: string, value: unknown, _model?: string): unknown {
    return value;
  }

  getModelContextLimit(
    _model?: string,
    _dynamic?: AgentDynamicData,
    sessionCtxWindow?: number,
  ): number {
    if (sessionCtxWindow && sessionCtxWindow > 0) return sessionCtxWindow;
    return 200_000;
  }

  renderSettings(
    values: Record<string, unknown>,
    onChange: (key: string, value: unknown) => void,
    opts: RenderSettingsOpts,
  ): React.ReactNode[] {
    const hide = new Set(opts.hideKeys ?? []);
    const dynamic = opts.dynamic;
    const nodes: React.ReactNode[] = [];

    // Model picker
    const models = this.getModels(dynamic);
    if (models.length > 0 && !hide.has('model')) {
      nodes.push(
        <ButtonGroup
          key="model"
          label="Model"
          options={models as Option[]}
          value={(values['model'] as string) ?? ''}
          onSelect={(m) => onChange('model', m.value)}
          size={opts.mode === 'new-session' ? 'sm' : undefined}
        />,
      );
    }

    for (const desc of this.getSettings(dynamic)) {
      if (opts.mode === 'new-session' && desc.sessionOnly) continue;
      if (hide.has(desc.key)) continue;

      const value = values[desc.key];
      nodes.push(this.renderSettingControl(desc, value, onChange, opts.mode));
    }

    return nodes;
  }

  /** Render a single setting control. Subclasses can override per key. */
  protected renderSettingControl(
    desc: SettingDescriptor,
    value: unknown,
    onChange: (key: string, value: unknown) => void,
    mode: 'new-session' | 'active-session',
  ): React.ReactNode {
    const size = mode === 'new-session' ? 'sm' : undefined;

    if (desc.setting.kind === 'preset') {
      return (
        <ButtonGroup
          key={desc.key}
          label={desc.label}
          options={desc.setting.options as Option[]}
          value={(value as string) ?? ''}
          onSelect={(o) => onChange(desc.key, o.value)}
          size={size}
          layout={desc.key === 'permissionMode' ? 'grid-2' : undefined}
        />
      );
    }

    if (desc.setting.kind === 'boolean') {
      return (
        <ToggleSwitch
          key={desc.key}
          label={desc.label}
          description="Restrict writes to project directory"
          enabled={(value as boolean) ?? false}
          onChange={(v) => onChange(desc.key, v)}
          compact={mode === 'new-session'}
        />
      );
    }

    if (desc.setting.kind === 'text') {
      return (
        <div key={desc.key} className="space-y-1">
          <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">
            {desc.label}
          </label>
          <input
            type="text"
            value={(value as string) ?? ''}
            onChange={(e) => onChange(desc.key, e.target.value)}
            placeholder={(desc.setting as { kind: 'text'; placeholder?: string }).placeholder ?? ''}
            className="w-full bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>
      );
    }

    return null;
  }

  renderStatusChips(
    values: Record<string, unknown>,
    onChange: (key: string, value: unknown) => void,
    opts: RenderChipsOpts,
  ): React.ReactNode[] {
    const { openPopover, onOpenPopover, dynamic } = opts;
    const nodes: React.ReactNode[] = [];

    // Model chip
    const models = this.getModels(dynamic);
    if (models.length > 0) {
      const modelLabel = models.find((m) => m.value === values['model'])?.label
        ?? (values['model'] as string | undefined)
        ?? 'Unknown';
      nodes.push(
        <StatusChipButton
          key="model"
          chipKey="model"
          label={modelLabel}
          open={openPopover === 'model'}
          onOpen={() => onOpenPopover(openPopover === 'model' ? null : 'model')}
          options={models}
          currentValue={values['model'] as string}
          onSelect={(v) => { onChange('model', v); onOpenPopover(null); }}
        />,
      );
    }

    for (const desc of this.getSettings(dynamic)) {
      nodes.push(...this.renderSettingChip(desc, values, onChange, opts));
    }

    return nodes;
  }

  protected renderSettingChip(
    desc: SettingDescriptor,
    values: Record<string, unknown>,
    onChange: (key: string, value: unknown) => void,
    { openPopover, onOpenPopover }: RenderChipsOpts,
  ): React.ReactNode[] {
    const value = values[desc.key];
    if (desc.setting.kind === 'preset') {
      const label = desc.setting.options.find((o) => o.value === value)?.label
        ?? (value as string | undefined)
        ?? desc.label;
      return [
        <StatusChipButton
          key={desc.key}
          chipKey={desc.key}
          icon={chipIcon(desc.key)}
          label={label}
          open={openPopover === desc.key}
          onOpen={() => onOpenPopover(openPopover === desc.key ? null : desc.key)}
          options={desc.setting.options}
          currentValue={value as string}
          onSelect={(v) => { onChange(desc.key, v); onOpenPopover(null); }}
        />,
      ];
    }
    if (desc.setting.kind === 'boolean') {
      return [
        <StatusChipButton
          key={desc.key}
          chipKey={desc.key}
          icon={chipIcon(desc.key)}
          label={desc.label}
          onToggle={() => onChange(desc.key, !value)}
          active={value as boolean}
        />,
      ];
    }
    return [];
  }

  renderSidebarAdvanced(
    _values: Record<string, unknown>,
    _onChange: (key: string, value: unknown) => void,
    _dynamic?: AgentDynamicData,
  ): React.ReactNode | null {
    return null;
  }
}

function chipIcon(key: string): React.ReactNode {
  switch (key) {
    case 'permissionMode':
      return (
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      );
    case 'reasoningEffort':
      return (
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      );
    case 'contextWindow':
      return (
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM4 9h16" />
        </svg>
      );
    case 'sandbox':
      return (
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      );
    default:
      return null;
  }
}

// ── Claude Code ───────────────────────────────────────────────────────────────

class ClaudeCodeAgentProvider extends BaseAgentProvider {
  readonly id: AgentId = 'claude-code';
  readonly label: string = 'Claude Code';
  readonly description: string = 'Full tool access — reads, edits, runs code';
  readonly capabilities: AgentCapabilities = {
    hasApiKey: true, hasCli: true, hasPlugin: true,
    supportsResume: true, supportsSandbox: true, supportsStreaming: true,
    supportsAttachments: true,
    supportedAttachmentKinds: ['image', 'pdf', 'text'],
  };
  readonly features = ['controlPalette', 'git', 'sandbox'] as const;
  readonly defaultModel = CLAUDE_MODELS[CLAUDE_MODELS.length - 1].value;
  readonly defaultPermissionMode = 'auto';
  readonly defaultReasoningEffort = 'high';

  getModels(): ReadonlyArray<Option> { return CLAUDE_MODELS; }

  getSettings(_dynamic?: AgentDynamicData): ReadonlyArray<SettingDescriptor> {
    return [
      {
        key: 'permissionMode',
        label: 'Permission',
        setting: { kind: 'preset', options: PERMISSION_MODES },
        default: 'auto',
      },
      {
        key: 'reasoningEffort',
        label: 'Reasoning effort',
        setting: { kind: 'preset', options: REASONING_EFFORTS_CLAUDE },
        default: 'high',
      },
      {
        key: 'contextWindow',
        label: 'Context window',
        setting: { kind: 'preset', options: CLAUDE_CONTEXT_WINDOWS.map((o) => ({ value: String(o.value), label: o.label })) },
        default: DEFAULT_CONTEXT_WINDOW,
      },
      {
        key: 'sandbox',
        label: 'Sandbox',
        setting: { kind: 'boolean' },
        default: true,
      },
    ];
  }

  clampSetting(key: string, value: unknown, model?: string): unknown {
    if (key === 'contextWindow') {
      return clampContextWindowForModel(model, value as number | undefined);
    }
    return value;
  }

  getModelContextLimit(model?: string, _dynamic?: AgentDynamicData, sessionCtxWindow?: number): number {
    if (sessionCtxWindow && sessionCtxWindow > 0) return sessionCtxWindow;
    if (!model) return DEFAULT_CONTEXT_WINDOW;
    if (/\[1m\]$/i.test(model)) return 1_000_000;
    return DEFAULT_CONTEXT_WINDOW;
  }

  protected renderSettingControl(
    desc: SettingDescriptor,
    value: unknown,
    onChange: (key: string, value: unknown) => void,
    mode: 'new-session' | 'active-session',
  ): React.ReactNode {
    if (desc.key === 'sandbox') {
      return (
        <SandboxSettingControl
          key="sandbox"
          enabled={(value as boolean) ?? true}
          onChange={(v) => onChange('sandbox', v)}
          compact={mode === 'new-session'}
        />
      );
    }

    // Context window: hide if only one option (Haiku locked to 200k)
    if (desc.key === 'contextWindow') {
      // We don't have `model` here directly, so we use a fallback
      return (
        <ButtonGroup
          key="contextWindow"
          label={desc.label}
          options={desc.setting.kind === 'preset' ? desc.setting.options as Option[] : []}
          value={String(value ?? DEFAULT_CONTEXT_WINDOW)}
          onSelect={(o) => onChange('contextWindow', Number(o.value))}
          size={mode === 'new-session' ? 'sm' : undefined}
        />
      );
    }

    return super.renderSettingControl(desc, value, onChange, mode);
  }

  renderSettings(
    values: Record<string, unknown>,
    onChange: (key: string, value: unknown) => void,
    opts: RenderSettingsOpts,
  ): React.ReactNode[] {
    const nodes = super.renderSettings(values, onChange, opts);

    // Filter out context window chip when only one option available
    // by post-processing: replace contextWindow node if it's hidden
    // (Haiku locked to 200k, Sonnet locked to 200k without billed opt-in
    // — options list collapses to one entry).
    const model = values['model'] as string | undefined;
    const cwOptions = getContextWindowOptionsForModel(model, { allowBilled: opts.allow1mForBilledModels });
    if (cwOptions.length <= 1) {
      const idx = nodes.findIndex(
        (n) => React.isValidElement(n) && (n as React.ReactElement).key === 'contextWindow',
      );
      if (idx !== -1) nodes.splice(idx, 1);
    }

    return nodes;
  }

  renderStatusChips(
    values: Record<string, unknown>,
    onChange: (key: string, value: unknown) => void,
    opts: RenderChipsOpts,
  ): React.ReactNode[] {
    const model = values['model'] as string | undefined;
    const cwOptions = getContextWindowOptionsForModel(model, { allowBilled: opts.allow1mForBilledModels });

    // Build chips but skip contextWindow if only one option
    const nodes = super.renderStatusChips(values, onChange, opts);
    if (cwOptions.length <= 1) {
      const idx = nodes.findIndex(
        (n) => React.isValidElement(n) && (n as React.ReactElement).key === 'contextWindow',
      );
      if (idx !== -1) nodes.splice(idx, 1);
    }

    // Format context window label nicely
    const cwIdx = nodes.findIndex(
      (n) => React.isValidElement(n) && (n as React.ReactElement).key === 'contextWindow',
    );
    if (cwIdx !== -1) {
      const cw = values['contextWindow'] as number | undefined ?? DEFAULT_CONTEXT_WINDOW;
      const cwLabel = formatContextWindow(cw);
      const { openPopover, onOpenPopover } = opts;
      nodes[cwIdx] = (
        <StatusChipButton
          key="contextWindow"
          chipKey="contextWindow"
          icon={chipIcon('contextWindow')}
          label={cwLabel}
          open={openPopover === 'contextWindow'}
          onOpen={() => onOpenPopover(openPopover === 'contextWindow' ? null : 'contextWindow')}
          options={cwOptions.map((o) => ({ value: String(o.value), label: o.label }))}
          currentValue={String(values['contextWindow'] ?? DEFAULT_CONTEXT_WINDOW)}
          onSelect={(v) => { onChange('contextWindow', Number(v)); onOpenPopover(null); }}
        />
      );
    }

    return nodes;
  }
}

function formatContextWindow(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${value / 1_000}k`;
  return String(value);
}

// ── Codex ─────────────────────────────────────────────────────────────────────

class CodexAgentProvider extends BaseAgentProvider {
  readonly id = 'codex' as const;
  readonly label = 'Codex';
  readonly description = 'OpenAI Codex via MCP server';
  readonly capabilities: AgentCapabilities = {
    hasApiKey: false, hasCli: true, hasPlugin: true,
    supportsResume: true, supportsSandbox: false, supportsStreaming: true,
    supportsAttachments: true,
    supportedAttachmentKinds: ['image', 'text'],
  };
  readonly features = ['git'] as const;
  readonly defaultModel = 'gpt-5.5';
  readonly defaultPermissionMode = 'default';
  readonly defaultReasoningEffort = 'medium';

  getModels(dynamic?: AgentDynamicData): ReadonlyArray<Option> {
    const models = dynamic?.codexModels;
    return models?.length ? codexModelsToOptions(models) : CODEX_MODELS_FALLBACK;
  }

  getSettings(dynamic?: AgentDynamicData): ReadonlyArray<SettingDescriptor> {
    const model = dynamic?.codexModels;
    const reasoningOptions = (() => {
      if (model?.length) {
        const found = model[0]; // fallback — caller should pass current model id
        if (found?.reasoningEfforts?.length) {
          return found.reasoningEfforts.map((e) => ({
            value: e,
            label: e === 'xhigh' ? 'X-High' : e[0].toUpperCase() + e.slice(1),
          }));
        }
      }
      return REASONING_EFFORTS_CODEX_FALLBACK;
    })();

    return [
      {
        key: 'permissionMode',
        label: 'Permission',
        setting: { kind: 'preset', options: CODEX_PERMISSION_MODES },
        default: 'default',
      },
      {
        key: 'reasoningEffort',
        label: 'Reasoning effort',
        setting: { kind: 'preset', options: reasoningOptions },
        default: 'medium',
      },
    ];
  }

  getModelContextLimit(model?: string, dynamic?: AgentDynamicData, _sessionCtxWindow?: number): number {
    return getPresetModelContextLimit(model, dynamic?.codexModels);
  }
}

// ── OpenCode ──────────────────────────────────────────────────────────────────

class OpenCodeAgentProvider extends BaseAgentProvider {
  readonly id = 'opencode' as const;
  readonly label = 'OpenCode';
  readonly description = 'OpenCode via local vLLM';
  readonly capabilities: AgentCapabilities = {
    hasApiKey: false, hasCli: true, hasPlugin: false,
    supportsResume: false, supportsSandbox: false, supportsStreaming: true,
  };
  readonly features = ['git'] as const;
  readonly defaultModel = '';
  readonly defaultPermissionMode = 'bypassPermissions';
  readonly defaultReasoningEffort = '';

  getModels(dynamic?: AgentDynamicData): ReadonlyArray<Option> {
    return (dynamic?.opencodeModels ?? []).map((m) => ({ value: m.id, label: m.name }));
  }

  getSettings(): ReadonlyArray<SettingDescriptor> {
    return [
      {
        key: 'permissionMode',
        label: 'Permission',
        setting: { kind: 'preset', options: OPENCODE_PERMISSION_MODES },
        default: 'bypassPermissions',
      },
    ];
  }

  renderStatusChips(
    values: Record<string, unknown>,
    onChange: (key: string, value: unknown) => void,
    opts: RenderChipsOpts,
  ): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    const model = (values['model'] as string | undefined) || '(default)';

    // Model: read-only chip (no dropdown — set at session start only)
    nodes.push(
      <span
        key="model"
        className="flex items-center gap-1 px-2 py-1 rounded-md bg-slate-700/60 text-slate-400 text-xs"
        title="Model is set at session start and cannot be changed mid-session"
      >
        {model}
      </span>,
    );

    // Other settings (permissionMode etc.) use base chip rendering
    for (const desc of this.getSettings()) {
      if (desc.key === 'model') continue;
      nodes.push(...this.renderSettingChip(desc, values, onChange, opts));
    }

    return nodes;
  }
}

// ── Pi ────────────────────────────────────────────────────────────────────────

class PiAgentProvider extends BaseAgentProvider {
  readonly id = 'pi' as const;
  readonly label = 'Pi';
  readonly description = 'Pi agent for quicksave sessions';
  readonly capabilities: AgentCapabilities = {
    hasApiKey: false, hasCli: true, hasPlugin: false,
    supportsResume: true, supportsSandbox: true, supportsStreaming: true,
  };
  readonly features = ['git', 'sandbox'] as const;
  readonly defaultModel = '';
  readonly defaultPermissionMode = 'auto';
  readonly defaultReasoningEffort = '';

  getModels(): ReadonlyArray<Option> { return []; }

  getSettings(): ReadonlyArray<SettingDescriptor> {
    return [
      {
        key: 'permissionMode',
        label: 'Permission',
        setting: { kind: 'preset', options: PERMISSION_MODES },
        default: 'auto',
      },
      {
        key: 'sandbox',
        label: 'Sandbox',
        setting: { kind: 'boolean' },
        default: true,
      },
    ];
  }

  protected renderSettingControl(
    desc: SettingDescriptor,
    value: unknown,
    onChange: (key: string, value: unknown) => void,
    mode: 'new-session' | 'active-session',
  ): React.ReactNode {
    if (desc.key === 'sandbox') {
      return (
        <ToggleSwitch
          key="sandbox"
          label="Sandbox"
          description="Restrict writes to project directory"
          enabled={(value as boolean) ?? true}
          onChange={(v) => onChange('sandbox', v)}
          compact={mode === 'new-session'}
        />
      );
    }
    return super.renderSettingControl(desc, value, onChange, mode);
  }
}

/**
 * Same shape as Claude Code, but the daemon spawns `claude` in its TUI and
 * we render the live terminal alongside structured cards. See
 * `apps/agent/src/ai/claudeTerminal/`.
 */
class ClaudeTerminalAgentProvider extends ClaudeCodeAgentProvider {
  readonly id: AgentId = 'claude-terminal';
  readonly label: string = 'Claude (Terminal)';
  readonly description: string = 'Live terminal + structured cards — uses your Claude subscription as interactive use';
}

// ── Registry ──────────────────────────────────────────────────────────────────

const PROVIDER_INSTANCES: Record<AgentId, AgentProvider> = {
  'claude-code': new ClaudeCodeAgentProvider(),
  'claude-terminal': new ClaudeTerminalAgentProvider(),
  codex: new CodexAgentProvider(),
  opencode: new OpenCodeAgentProvider(),
  pi: new PiAgentProvider(),
};

export function getAgentProvider(id: AgentId): AgentProvider {
  return PROVIDER_INSTANCES[id] ?? PROVIDER_INSTANCES['claude-code'];
}

export function getAllAgentProviders(): AgentProvider[] {
  return Object.values(PROVIDER_INSTANCES);
}

export const AGENT_TYPES: AgentType[] = getAllAgentProviders()
  .filter((p) => p.id !== 'pi') // Pi is internal, not shown in agent picker
  .map((p) => ({
    value: p.id,
    label: p.label,
    description: p.description,
    allowedTools: p.allowedTools,
    systemPrompt: p.systemPrompt,
  }));
