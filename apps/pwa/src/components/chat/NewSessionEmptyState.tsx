// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { clsx } from 'clsx';
import { FormattedMessage, useIntl } from 'react-intl';
import { useClaudeStore } from '../../stores/claudeStore';
import { useConnectionStore } from '../../stores/connectionStore';
import {
  AGENT_TYPES,
  getContextWindowOptionsForModel,
  getModelsForAgent,
  getPermissionModesForAgent,
  getReasoningEffortsForModel,
} from '../../lib/claudePresets';
import { ButtonGroup } from '../ui/ButtonGroup';
import { ToggleSwitch } from '../ui/ToggleSwitch';
import type { ProjectEntry } from '../../hooks/useProjects';
import { MachineIcon } from '../icons/MachineIcon';
import { CodexLoginBanner } from './CodexLogin';
import { useCodexLogin } from '../../hooks/useCodexLogin';

export interface NewSessionEmptyStateProps {
  cwd?: string;
  /** When provided, replaces the static cwd line with a project dropdown. */
  projectSelector?: {
    projects: ProjectEntry[];
    selectedProjectId: string | null;
    onSelect: (projectId: string) => void;
  };
}

export function NewSessionEmptyState({ cwd, projectSelector }: NewSessionEmptyStateProps) {
  const intl = useIntl();
  const {
    selectedAgent,
    selectedModel,
    selectedPermissionMode,
    selectedReasoningEffort,
    selectedContextWindow,
    sandboxEnabled,
    setSelectedAgent,
    setSelectedModel,
    setSelectedPermissionMode,
    setSelectedReasoningEffort,
    setSelectedContextWindow,
    setSandboxEnabled,
  } = useClaudeStore();
  const codexModels = useConnectionStore((s) => s.codexModels);
  const isCodexAgent = selectedAgent === 'codex';
  const models = getModelsForAgent(selectedAgent, codexModels);
  // Codex permission presets bundle sandbox_mode, so the toggle below is
  // hidden for codex; Claude has independent axes so it stays visible.
  const showSandboxToggle = !isCodexAgent;
  const supportsReasoning = true; // both agents expose a reasoning chip
  const [sandboxHelpOpen, setSandboxHelpOpen] = useState(false);
  // Codex login gate: when the agent picker points at Codex but the daemon
  // has no credentials, surface a banner + device-auth modal so a remote
  // user can complete OAuth without touching the machine the daemon runs on.
  const { loginState } = useCodexLogin();
  const showCodexLoginGate = isCodexAgent && loginState?.loggedIn === false;

  // Permission presets and reasoning levels both differ per agent — derive
  // both lists from the active agent so the new-session pickers match what
  // the SessionStatusBar will show once the session starts.
  const permissionModes = getPermissionModesForAgent(selectedAgent);
  const reasoningEfforts = getReasoningEffortsForModel(selectedAgent, selectedModel, codexModels);
  // Claude-only: Haiku is locked to 200k so its option list collapses to one
  // entry — hide the picker in that case (matches SessionStatusBar).
  const contextWindowOptions = !isCodexAgent
    ? getContextWindowOptionsForModel(selectedModel)
    : [];
  const showContextWindow = contextWindowOptions.length > 1;
  // Localize labels for the Claude reasoning enum (low/medium/high/max);
  // codex labels stay as-is since they're already short and keyed off the
  // SDK's own value names.
  const reasoningEffortOptions = reasoningEfforts.map((e) => {
    const intlKey = `newSession.reasoningEffort.${e.value}`;
    const localized = intl.formatMessage({ id: intlKey, defaultMessage: e.label });
    return { value: e.value, label: localized };
  });

  const selected = projectSelector
    ? projectSelector.projects.find((p) => p.projectId === projectSelector.selectedProjectId) ?? null
    : null;

  return (
    <div className="px-4 pt-4 pb-2 flex justify-start">
      <div className="bg-slate-800/50 rounded-xl p-4 space-y-4 border border-slate-700/50 inline-block min-w-0">
        {/* Title + project / path */}
        <div>
          <h2 className="text-sm font-semibold text-slate-200">
            <FormattedMessage id="newSession.title" />
          </h2>
          {projectSelector ? (
            <div className="mt-1.5 min-w-0">
              <ProjectDropdown
                projects={projectSelector.projects}
                selected={selected}
                onSelect={projectSelector.onSelect}
                placeholder={intl.formatMessage({ id: 'newSession.project.placeholder' })}
                offlineLabel={intl.formatMessage({ id: 'newSession.project.offline' })}
              />
            </div>
          ) : (
            cwd && (
              <p className="mt-0.5 text-xs text-slate-500 flex items-center gap-1 min-w-0">
                <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                </svg>
                <span className="truncate">{cwd}</span>
              </p>
            )
          )}
        </div>

        {/* Selectors */}
        <ButtonGroup label={intl.formatMessage({ id: 'newSession.agent' })} options={AGENT_TYPES} value={selectedAgent} onSelect={(agent) => setSelectedAgent(agent.value)} size="sm" />
        {showCodexLoginGate && <CodexLoginBanner />}
        <ButtonGroup label={intl.formatMessage({ id: 'newSession.model' })} options={models} value={selectedModel} onSelect={(m) => setSelectedModel(m.value)} size="sm" />
        {showContextWindow && (
          <ButtonGroup
            label={intl.formatMessage({ id: 'newSession.contextWindow' })}
            options={contextWindowOptions.map((o) => ({ value: String(o.value), label: o.label }))}
            value={String(selectedContextWindow)}
            onSelect={(o) => setSelectedContextWindow(Number(o.value))}
            size="sm"
          />
        )}
        {supportsReasoning && (
          <ButtonGroup label={intl.formatMessage({ id: 'newSession.reasoningEffort' })} options={reasoningEffortOptions} value={selectedReasoningEffort} onSelect={(e) => setSelectedReasoningEffort(e.value)} size="sm" />
        )}
        <ButtonGroup label={intl.formatMessage({ id: 'newSession.permission' })} options={permissionModes} value={selectedPermissionMode} onSelect={(p) => setSelectedPermissionMode(p.value)} size="sm" />

        {/* Sandbox toggle + inline explainer — hidden for codex because its
            permission preset already encodes sandbox_mode. */}
        {showSandboxToggle && (
        <div className="space-y-2">
          <ToggleSwitch
            label={intl.formatMessage({ id: 'newSession.sandbox' })}
            enabled={sandboxEnabled}
            onChange={setSandboxEnabled}
            compact
          />
          <button
            type="button"
            onClick={() => setSandboxHelpOpen((v) => !v)}
            aria-expanded={sandboxHelpOpen}
            className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <FormattedMessage id="newSession.sandbox.help.toggle" />
          </button>
          {sandboxHelpOpen && (
            <div className="text-[11px] text-slate-400 space-y-1.5 rounded-md border border-slate-700/60 bg-slate-900/40 p-2.5">
              <p className="font-semibold text-slate-300">
                <FormattedMessage id="newSession.sandbox.help.title" />
              </p>
              <p>
                <span className="text-emerald-400 font-medium">
                  <FormattedMessage id="newSession.sandbox.help.onLabel" />
                </span>{' '}
                <FormattedMessage id="newSession.sandbox.help.onBody" />
              </p>
              <p>
                <span className="text-amber-400 font-medium">
                  <FormattedMessage id="newSession.sandbox.help.offLabel" />
                </span>{' '}
                <FormattedMessage id="newSession.sandbox.help.offBody" />
              </p>
            </div>
          )}
        </div>
        )}

        {/* Hint */}
        <p className="text-xs text-slate-600">
          <FormattedMessage id="newSession.hint" />
        </p>
      </div>
    </div>
  );
}

function ProjectDropdown({
  projects,
  selected,
  onSelect,
  placeholder,
  offlineLabel,
}: {
  projects: ProjectEntry[];
  selected: ProjectEntry | null;
  onSelect: (projectId: string) => void;
  placeholder: string;
  offlineLabel: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full min-w-[16rem] flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-left text-slate-200 text-sm rounded-md px-2.5 py-1.5 border border-slate-700 focus:outline-none focus:border-blue-500 transition-colors"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div className="flex-1 min-w-0">
          {selected ? (
            <ProjectRow project={selected} offlineLabel={offlineLabel} />
          ) : (
            <span className="text-slate-400">{placeholder}</span>
          )}
        </div>
        <svg
          className={clsx('w-4 h-4 text-slate-400 shrink-0 transition-transform', open && 'rotate-180')}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <ul
            role="listbox"
            className="absolute left-0 right-0 top-full mt-1 z-50 max-h-72 overflow-y-auto bg-slate-900 rounded-lg shadow-xl border border-slate-700 py-1"
          >
            {projects.map((p) => {
              const isSelected = selected?.projectId === p.projectId;
              return (
                <li key={p.projectId} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    disabled={!p.isConnected}
                    onClick={() => {
                      onSelect(p.projectId);
                      setOpen(false);
                    }}
                    className={clsx(
                      'w-full text-left px-3 py-2 transition-colors',
                      isSelected ? 'bg-blue-600/20' : 'hover:bg-slate-800',
                      !p.isConnected && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    <ProjectRow project={p} offlineLabel={offlineLabel} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function ProjectRow({ project, offlineLabel }: { project: ProjectEntry; offlineLabel: string }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-slate-200">
        <MachineIcon className="w-3.5 h-3.5 shrink-0 text-slate-400" />
        <span className="font-medium break-words">{project.displayName}</span>
        <span className="text-slate-400 break-words">· {project.machineName}</span>
        {!project.isConnected && (
          <span className="text-[10px] uppercase tracking-wide text-slate-500 shrink-0">{offlineLabel}</span>
        )}
      </div>
      <p className="text-[11px] text-slate-500 font-mono break-all" title={project.cwd}>
        {project.cwd}
      </p>
    </div>
  );
}
