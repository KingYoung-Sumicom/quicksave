import { SwipeableDrawer } from './SwipeableDrawer';
import { useConnectionStore } from '../stores/connectionStore';
import { useGitStore } from '../stores/gitStore';
import { DevicePairingSection } from './DevicePairingSection';
import { ApiKeySection } from './settings/ApiKeySection';
import { PrimaryKeySection } from './settings/PrimaryKeySection';
import { AgentUpdateSection } from './settings/AgentUpdateSection';
import { NotificationSection } from './settings/NotificationSection';
import type { Message, PushSubscriptionOfferPayload } from '@sumicom/quicksave-shared';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSendApiKeyToAgent?: (apiKey: string) => Promise<boolean>;
  onCheckAgentUpdate?: () => Promise<{ currentVersion: string; latestVersion?: string; updateAvailable: boolean; error?: string }>;
  onUpdateAgent?: () => Promise<{ success: boolean; previousVersion: string; newVersion?: string; restarting: boolean; error?: string }>;
  onPushOffer?: (msg: Message<PushSubscriptionOfferPayload>) => void;
}

export function SettingsPanel({ isOpen, onClose, onSendApiKeyToAgent, onCheckAgentUpdate, onUpdateAgent, onPushOffer }: SettingsPanelProps) {
  const connectionState = useConnectionStore((s) => s.state);

  return (
    <SwipeableDrawer isOpen={isOpen} onClose={onClose} side="right" drawerWidth={400} className="w-[90%] max-w-[400px] bg-slate-800 flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-700 rounded-md transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">

          <ApiKeySection isOpen={isOpen} onSendApiKeyToAgent={onSendApiKeyToAgent} />

          <div className="border-t border-slate-700" />

          <PrimaryKeySection />

          <div className="border-t border-slate-700" />

          <DevicePairingSection />

          <div className="border-t border-slate-700" />

          <NotificationSection onPushOffer={onPushOffer} />

          {/* Git Attribution */}
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

          {/* Agent Update — only when connected */}
          {connectionState === 'connected' && (
            <>
              <div className="border-t border-slate-700" />
              <AgentUpdateSection
                isOpen={isOpen}
                onCheckAgentUpdate={onCheckAgentUpdate}
                onUpdateAgent={onUpdateAgent}
              />
            </>
          )}
        </div>
    </SwipeableDrawer>
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
