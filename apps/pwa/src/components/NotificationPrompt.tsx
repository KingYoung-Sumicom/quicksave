// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useNotificationEnable } from '../hooks/useNotificationEnable';
import type { Message, PushSubscriptionOfferPayload } from '@sumicom/quicksave-shared';

const DISMISS_KEY = 'quicksave-notification-prompt-dismissed';

interface NotificationPromptProps {
  /** Called with the push-subscription-offer envelope when the user grants
   *  permission. Parent is expected to forward it over the E2E WS channel. */
  onOffer: (msg: Message<PushSubscriptionOfferPayload>) => void;
}

/**
 * First-run notification opt-in banner. Floats at the bottom of the viewport
 * so it doesn't push layout — dismissing it removes it entirely. Users who
 * dismiss can still re-enable later from the Settings panel.
 */
export function NotificationPrompt({ onOffer }: NotificationPromptProps) {
  const intl = useIntl();
  const { isSupported, permission, busy, error, enable } = useNotificationEnable(onOffer);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(DISMISS_KEY)) {
      setDismissed(true);
    }
  }, []);

  if (!isSupported) return null;
  if (permission !== 'default') return null;
  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore quota/private-mode */ }
  };

  return (
    <div className="fixed left-0 right-0 bottom-0 z-40 pointer-events-none safe-area-bottom safe-area-x">
      <div className="mx-auto max-w-md px-4 pb-4 pointer-events-auto">
        <div className="p-3 bg-blue-500/10 border border-blue-500/30 backdrop-blur-sm rounded-lg shadow-lg flex items-center gap-3">
          <div className="flex-1 text-sm text-blue-300">
            {error
              ? <FormattedMessage id="notificationPrompt.errorPrefix" values={{ error }} />
              : <FormattedMessage id="notificationPrompt.prompt" />}
          </div>
          <button
            type="button"
            onClick={enable}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-blue-700/60 rounded-md text-white transition-colors"
          >
            <FormattedMessage id={busy ? 'notificationPrompt.enabling' : 'notificationPrompt.enable'} />
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label={intl.formatMessage({ id: 'notificationPrompt.dismissAria' })}
            className="p-1 text-slate-500 hover:text-slate-400"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
