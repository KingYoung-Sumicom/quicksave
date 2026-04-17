import { useNotificationEnable } from '../../hooks/useNotificationEnable';
import { Spinner } from '../ui/Spinner';
import { ErrorBox } from '../ui/ErrorBox';
import type { Message, PushSubscriptionOfferPayload } from '@sumicom/quicksave-shared';

interface NotificationSectionProps {
  onPushOffer?: (msg: Message<PushSubscriptionOfferPayload>) => void;
}

export function NotificationSection({ onPushOffer }: NotificationSectionProps) {
  const { isSupported, permission, busy, error, enable } = useNotificationEnable(onPushOffer);

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
        Notifications
      </h3>

      <p className="text-sm text-slate-300">
        Get alerted when a session needs your attention.
      </p>

      {!isSupported ? (
        <p className="text-xs text-slate-500">
          Push notifications aren&apos;t available in this browser.
        </p>
      ) : permission === 'denied' ? (
        <p className="text-xs text-slate-400">
          Notifications are blocked. Update the permission in your browser settings to re-enable.
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
            Enabled
          </span>
          <button
            onClick={enable}
            disabled={busy}
            className="text-xs text-slate-400 hover:text-slate-300 transition-colors disabled:opacity-50"
          >
            {busy ? 'Refreshing…' : 'Re-register'}
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
              Enabling…
            </>
          ) : (
            'Enable Notifications'
          )}
        </button>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}
    </div>
  );
}
