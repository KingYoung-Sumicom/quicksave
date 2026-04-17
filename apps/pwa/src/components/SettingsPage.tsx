import { useNavigate } from 'react-router-dom';
import { useGitStore } from '../stores/gitStore';
import { BaseStatusBar, BackButton } from './BaseStatusBar';
import { DevicePairingSection } from './DevicePairingSection';
import { ApiKeySection } from './settings/ApiKeySection';
import { PrimaryKeySection } from './settings/PrimaryKeySection';
import { NotificationSection } from './settings/NotificationSection';
import type { Message, PushSubscriptionOfferPayload } from '@sumicom/quicksave-shared';

interface SettingsPageProps {
  onSendApiKeyToAgent?: (apiKey: string) => Promise<boolean>;
  onPushOffer?: (msg: Message<PushSubscriptionOfferPayload>) => void;
}

export function SettingsPage({ onSendApiKeyToAgent, onPushOffer }: SettingsPageProps) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <BaseStatusBar
        left={<BackButton onClick={() => navigate(-1)} />}
        center={<span className="text-sm font-medium text-slate-300">Settings</span>}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto p-4 space-y-6">
          <ApiKeySection isOpen onSendApiKeyToAgent={onSendApiKeyToAgent} />

          <div className="border-t border-slate-700" />

          <PrimaryKeySection />

          <div className="border-t border-slate-700" />

          <DevicePairingSection />

          <div className="border-t border-slate-700" />

          <NotificationSection onPushOffer={onPushOffer} />

          <div className="border-t border-slate-700" />
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Git
            </h3>
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <span className="text-sm text-white">Commit attribution</span>
                <p className="text-xs text-slate-400 mt-0.5">Add Quicksave trailer to commit messages</p>
              </div>
              <AttributionToggle />
            </label>
          </div>

        </div>
      </div>
    </div>
  );
}

function AttributionToggle() {
  const enabled = useGitStore((s) => s.attributionEnabled);
  const setEnabled = useGitStore((s) => s.setAttributionEnabled);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => setEnabled(!enabled)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200 ease-in-out ${enabled ? 'bg-purple-600' : 'bg-slate-600'}`}
    >
      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out mt-0.5 ${enabled ? 'translate-x-5 ml-0.5' : 'translate-x-0 ml-0.5'}`} />
    </button>
  );
}
