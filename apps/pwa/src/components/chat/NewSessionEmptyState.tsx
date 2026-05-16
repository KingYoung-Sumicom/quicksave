// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { clsx } from 'clsx';
import { FormattedMessage, useIntl } from 'react-intl';
import { useClaudeStore } from '../../stores/claudeStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { AGENT_TYPES, getAgentProvider } from '../../lib/agentProvider';
import { ButtonGroup } from '../ui/ButtonGroup';
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
  const { selectedAgent, selectedModel, agentPrefs, setSelectedAgent, setAgentSetting } = useClaudeStore();
  const codexModels = useConnectionStore((s) => s.codexModels);
  const { loginState } = useCodexLogin();

  const provider = getAgentProvider(selectedAgent);
  const opencodeModels = useConnectionStore((s) => s.opencodeModels);
  const dynamic = { codexModels, opencodeModels };
  const values: Record<string, unknown> = {
    model: selectedModel,
    ...agentPrefs[selectedAgent].settings,
  };
  const showCodexLoginGate = selectedAgent === 'codex' && loginState?.loggedIn === false;

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

        {/* Agent picker */}
        <ButtonGroup
          label={intl.formatMessage({ id: 'newSession.agent' })}
          options={AGENT_TYPES}
          value={selectedAgent}
          onSelect={(agent) => setSelectedAgent(agent.value as Parameters<typeof setSelectedAgent>[0])}
          size="sm"
        />
        {showCodexLoginGate && <CodexLoginBanner />}

        {/* Provider-owned settings — model + all knobs */}
        {provider.renderSettings(values, setAgentSetting, { mode: 'new-session', dynamic })}

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
