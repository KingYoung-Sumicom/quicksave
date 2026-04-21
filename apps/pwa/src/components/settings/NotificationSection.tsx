import { FormattedMessage } from 'react-intl';
import { useNotificationEnable } from '../../hooks/useNotificationEnable';
import type { PushSupportStatus } from '../../lib/pushSubscription';
import { Spinner } from '../ui/Spinner';
import { ErrorBox } from '../ui/ErrorBox';
import type { Message, PushSubscriptionOfferPayload } from '@sumicom/quicksave-shared';

interface NotificationSectionProps {
  onPushOffer?: (msg: Message<PushSubscriptionOfferPayload>) => void;
}

function unsupportedMessageId(status: PushSupportStatus): string {
  if (status.ok) return 'settings.notifications.unsupported';
  switch (status.kind) {
    case 'ios-not-standalone':
      return 'settings.notifications.unsupported.iosStandalone';
    case 'no-vapid-key':
      return 'settings.notifications.unsupported.noVapidKey';
    case 'no-browser-support':
      return 'settings.notifications.unsupported.browser';
  }
}

export function NotificationSection({ onPushOffer }: NotificationSectionProps) {
  const { isSupported, supportStatus, permission, busy, error, enable } = useNotificationEnable(onPushOffer);

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
        <FormattedMessage id="settings.notifications.title" />
      </h3>

      <p className="text-sm text-slate-300">
        <FormattedMessage id="settings.notifications.description" />
      </p>

      {!isSupported ? (
        <p className="text-xs text-slate-500">
          <FormattedMessage id={unsupportedMessageId(supportStatus)} />
        </p>
      ) : permission === 'denied' ? (
        <p className="text-xs text-slate-400">
          <FormattedMessage id="settings.notifications.denied" />
        </p>
      ) : permission === 'granted' ? (
        <div className="flex items-center justify-between">
          <span className="text-xs text-green-400 flex items-center gap-1">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                clipRule="evenodd"
              />
            </svg>
            <FormattedMessage id="settings.notifications.enabled" />
          </span>
          <button
            onClick={enable}
            disabled={busy}
            className="text-xs text-slate-400 hover:text-slate-300 transition-colors disabled:opacity-50"
          >
            <FormattedMessage
              id={busy ? 'settings.notifications.refreshing' : 'settings.notifications.refresh'}
            />
          </button>
        </div>
      ) : (
        <button
          onClick={enable}
          disabled={busy}
          className="w-full py-2 px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2"
        >
          {busy ? (
            <>
              <Spinner color="border-white" />
              <FormattedMessage id="settings.notifications.enabling" />
            </>
          ) : (
            <FormattedMessage id="settings.notifications.enable" />
          )}
        </button>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}
    </div>
  );
}
