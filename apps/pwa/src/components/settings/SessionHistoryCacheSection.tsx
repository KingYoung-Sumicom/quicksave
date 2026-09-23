// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { clearSessionHistoryCache } from '../../lib/sessionHistoryCache';
import { useUiPrefsStore } from '../../stores/uiPrefsStore';
import { ToggleSwitch } from '../ui/ToggleSwitch';

export function SessionHistoryCacheSection() {
  const intl = useIntl();
  const cacheEnabled = useUiPrefsStore((s) => s.sessionHistoryCacheEnabled);
  const setCacheEnabled = useUiPrefsStore((s) => s.setSessionHistoryCacheEnabled);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'success' | 'error' | null>(null);

  const clearCache = async () => {
    if (busy) return;
    if (!window.confirm(intl.formatMessage({ id: 'settings.cache.confirm' }))) return;
    setBusy(true);
    setStatus(null);
    try {
      await clearSessionHistoryCache();
      setStatus('success');
    } catch {
      setStatus('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div>
        <span className="text-sm text-white">
          <FormattedMessage id="settings.cache.label" />
        </span>
        <p className="text-xs text-slate-400 mt-0.5">
          <FormattedMessage id="settings.cache.description" />
        </p>
      </div>
      <ToggleSwitch
        enabled={cacheEnabled}
        onChange={setCacheEnabled}
        label={intl.formatMessage({ id: 'settings.cache.enabled' })}
        description={intl.formatMessage({ id: 'settings.cache.disabledDescription' })}
      />
      <button
        type="button"
        onClick={clearCache}
        disabled={busy}
        className="w-full py-2 px-4 rounded-md font-medium bg-slate-700 hover:bg-slate-600 disabled:opacity-50"
      >
        <FormattedMessage id={busy ? 'settings.cache.clearing' : 'settings.cache.button'} />
      </button>
      {status === 'success' && (
        <p className="text-xs text-emerald-400"><FormattedMessage id="settings.cache.success" /></p>
      )}
      {status === 'error' && (
        <p className="text-xs text-red-400"><FormattedMessage id="settings.cache.error" /></p>
      )}
    </div>
  );
}
