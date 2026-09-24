// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { BackButton, BaseStatusBar } from '../BaseStatusBar';
import { SETTINGS_CATEGORIES, settingsCategoryFromPath } from './settingsCategories';

const ICON_PATHS: Record<string, ReactNode> = {
  sliders: <><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  sparkles: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 17l.6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6L19 17Z" /></>,
  microphone: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8" /></>,
  computer: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
  shield: <><path d="M12 2 4 5v6c0 5.2 3.4 8.6 8 11 4.6-2.4 8-5.8 8-11V5l-8-3Z" /><path d="m9 12 2 2 4-4" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
};

function CategoryIcon({ name }: { name: string }) {
  return (
    <svg aria-hidden="true" className="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {ICON_PATHS[name]}
    </svg>
  );
}

export function SettingsNavigation({ desktop = false }: { desktop?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const intl = useIntl();
  const active = settingsCategoryFromPath(location.pathname);
  const state = location.state as { returnTo?: string } | null;
  const returnTo = state?.returnTo?.startsWith('/') && !state.returnTo.startsWith('/settings') ? state.returnTo : '/';

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-800/50">
      <BaseStatusBar
        left={<BackButton onClick={() => navigate(returnTo)} />}
        center={<span className="text-sm font-semibold text-slate-100"><FormattedMessage id="settings.title" /></span>}
      />
      <nav aria-label={intl.formatMessage({ id: 'settings.navigation.aria' })} className="flex-1 overflow-y-auto px-3 py-5">
        {(['preferences', 'connections', 'data'] as const).map((group) => (
          <div key={group} className="mb-6">
            <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
              <FormattedMessage id={`settings.group.${group}`} />
            </p>
            <div className="space-y-1">
              {SETTINGS_CATEGORIES.filter((category) => category.group === group).map((category) => (
                <Link
                  key={category.id}
                  to={`/settings/${category.id}`}
                  state={state}
                  aria-current={desktop && active === category.id ? 'page' : undefined}
                  className={`group flex items-center gap-3 rounded-xl px-3 py-3 transition-colors ${desktop && active === category.id
                    ? 'bg-blue-500/15 text-blue-200 ring-1 ring-blue-400/25'
                    : 'text-slate-300 hover:bg-slate-700/70 hover:text-white'}`}
                >
                  <CategoryIcon name={category.icon} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium"><FormattedMessage id={category.titleId} /></span>
                    <span className="block truncate text-[11px] text-slate-400"><FormattedMessage id={category.descriptionId} /></span>
                  </span>
                  {!desktop && <span aria-hidden="true" className="text-slate-500">›</span>}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>
    </div>
  );
}
