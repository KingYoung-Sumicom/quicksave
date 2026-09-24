// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { FormattedMessage, useIntl } from 'react-intl';
import { useGitStore } from '../stores/gitStore';
import { BaseStatusBar, BackButton } from './BaseStatusBar';
import { PairDeviceModal } from './PairDeviceModal';
import { ScanToJoinModal } from './ScanToJoinModal';
import { ApiKeySection } from './settings/ApiKeySection';
import { VoiceSection } from './settings/VoiceSection';
import { DangerZoneSection } from './settings/DangerZoneSection';
import { NotificationSection } from './settings/NotificationSection';
import { MachinesSection } from './settings/MachinesSection';
import { LanguageSection } from './settings/LanguageSection';
import { SessionHistoryCacheSection } from './settings/SessionHistoryCacheSection';
import { PrimaryKeySection } from './settings/PrimaryKeySection';
import { SettingsNavigation } from './settings/SettingsNavigation';
import { SETTINGS_CATEGORIES, settingsCategoryFromPath, type SettingsCategoryId } from './settings/settingsCategories';
import type { Message, PushSubscriptionOfferPayload } from '@sumicom/quicksave-shared';

interface SettingsPageProps {
  desktop?: boolean;
  onSendApiKeyToAgent?: (apiKey: string) => Promise<boolean>;
  onPushOffer?: (msg: Message<PushSubscriptionOfferPayload>) => void;
}

function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-700/80 bg-slate-800/80 p-5 shadow-sm md:p-6">
      {children}
    </section>
  );
}

export function SettingsPage({ desktop = false, onSendApiKeyToAgent, onPushOffer }: SettingsPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { section } = useParams<{ section?: string }>();
  const intl = useIntl();
  const [showPairModal, setShowPairModal] = useState(false);
  const [showScanModal, setShowScanModal] = useState(false);
  const categoryId: SettingsCategoryId = settingsCategoryFromPath(location.pathname);
  const category = SETTINGS_CATEGORIES.find((entry) => entry.id === categoryId)!;

  if (!desktop && !section) return <SettingsNavigation />;

  let content: ReactNode;
  switch (categoryId) {
    case 'general':
      content = <>
        <SettingsCard><LanguageSection /></SettingsCard>
        <SettingsCard><NotificationSection onPushOffer={onPushOffer} /></SettingsCard>
      </>;
      break;
    case 'ai-git':
      content = <>
        <SettingsCard>
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-slate-100"><FormattedMessage id="settings.git.title" /></h2>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm text-slate-100"><FormattedMessage id="settings.git.commitAttribution.label" /></p>
                <p className="mt-1 text-xs text-slate-400"><FormattedMessage id="settings.git.commitAttribution.description" /></p>
              </div>
              <AttributionToggle />
            </div>
          </div>
        </SettingsCard>
        <SettingsCard><ApiKeySection isOpen onSendApiKeyToAgent={onSendApiKeyToAgent} /></SettingsCard>
      </>;
      break;
    case 'voice':
      content = <SettingsCard><VoiceSection isOpen /></SettingsCard>;
      break;
    case 'machines':
      content = <SettingsCard><MachinesSection /></SettingsCard>;
      break;
    case 'sync':
      content = <>
        <SettingsCard>
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-100"><FormattedMessage id="settings.deviceSync.title" /></h2>
              <p className="mt-1 text-xs text-slate-400"><FormattedMessage id="settings.category.sync.detail" /></p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <button type="button" onClick={() => setShowPairModal(true)} className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4 text-left transition-colors hover:bg-blue-500/20">
                <span className="block text-sm font-medium text-blue-200"><FormattedMessage id="settings.deviceSync.invite.button" /></span>
                <span className="mt-1 block text-xs leading-relaxed text-slate-400"><FormattedMessage id="settings.deviceSync.invite.description" /></span>
              </button>
              <button type="button" onClick={() => setShowScanModal(true)} className="rounded-xl border border-slate-600 bg-slate-700/50 p-4 text-left transition-colors hover:bg-slate-700">
                <span className="block text-sm font-medium text-slate-100"><FormattedMessage id="settings.deviceSync.join.button" /></span>
                <span className="mt-1 block text-xs leading-relaxed text-slate-400"><FormattedMessage id="settings.deviceSync.join.description" /></span>
              </button>
            </div>
          </div>
        </SettingsCard>
        <SettingsCard><PrimaryKeySection /></SettingsCard>
        <DangerZoneSection />
      </>;
      break;
    case 'storage':
      content = <SettingsCard><SessionHistoryCacheSection /></SettingsCard>;
      break;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-900">
      {desktop ? (
        <div className="flex h-[var(--app-bar-height)] shrink-0 items-center border-b border-slate-700/70 px-6 text-xs text-slate-400">
          <FormattedMessage id="settings.title" /><span aria-hidden="true" className="px-2">/</span>
          <span className="font-medium text-slate-200"><FormattedMessage id={category.titleId} /></span>
        </div>
      ) : (
        <BaseStatusBar
          left={<BackButton onClick={() => navigate('/settings', { state: location.state })} />}
          center={<span className="text-sm font-medium text-slate-100"><FormattedMessage id={category.titleId} /></span>}
        />
      )}

      <main className="flex-1 overflow-y-auto px-4 py-7 md:px-8 md:py-10">
        <div className="mx-auto max-w-3xl space-y-5">
          <div className="mb-8">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-blue-300"><FormattedMessage id="settings.title" /></p>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">{intl.formatMessage({ id: category.titleId })}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400"><FormattedMessage id={category.descriptionId} /></p>
          </div>
          {content}
        </div>
      </main>
      {showPairModal && <PairDeviceModal onClose={() => setShowPairModal(false)} />}
      {showScanModal && <ScanToJoinModal onClose={() => setShowScanModal(false)} />}
    </div>
  );
}

function AttributionToggle() {
  const intl = useIntl();
  const enabled = useGitStore((s) => s.attributionEnabled);
  const setEnabled = useGitStore((s) => s.setAttributionEnabled);
  return (
    <button
      type="button"
      role="switch"
      aria-label={intl.formatMessage({ id: 'settings.git.commitAttribution.label' })}
      aria-checked={enabled}
      onClick={() => setEnabled(!enabled)}
      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? 'bg-blue-500' : 'bg-slate-600'}`}
    >
      <span className={`pointer-events-none mt-0.5 ml-0.5 inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : ''}`} />
    </button>
  );
}
