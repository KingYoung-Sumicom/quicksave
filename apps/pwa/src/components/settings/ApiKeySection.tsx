// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, useEffect } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Spinner } from '../ui/Spinner';
import { ErrorBox } from '../ui/ErrorBox';
import { saveApiKey as saveApiKeyToStorage, hasApiKey } from '../../lib/secureStorage';

interface ApiKeySectionProps {
  isOpen: boolean;
  onSendApiKeyToAgent?: (apiKey: string) => Promise<boolean>;
}

export function ApiKeySection({ isOpen, onSendApiKeyToAgent }: ApiKeySectionProps) {
  const intl = useIntl();
  const [apiKey, setApiKey] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keySuccess, setKeySuccess] = useState(false);
  const [apiKeyStored, setApiKeyStored] = useState(false);
  const [showApiKeyHelp, setShowApiKeyHelp] = useState(false);

  useEffect(() => {
    if (isOpen) {
      hasApiKey().then((stored) => {
        setApiKeyStored(stored);
        if (!stored) setShowApiKeyHelp(true);
      });
    }
  }, [isOpen]);

  async function handleSaveApiKey(): Promise<void> {
    if (!apiKey.trim()) {
      setKeyError(intl.formatMessage({ id: 'settings.apiKey.error.empty' }));
      return;
    }

    setIsSavingKey(true);
    setKeyError(null);
    setKeySuccess(false);

    try {
      await saveApiKeyToStorage(apiKey.trim());
      setApiKeyStored(true);

      if (onSendApiKeyToAgent) {
        await onSendApiKeyToAgent(apiKey.trim());
      }

      setKeySuccess(true);
      setApiKey('');
      setTimeout(() => setKeySuccess(false), 2000);
    } catch (err) {
      setKeyError(
        err instanceof Error
          ? err.message
          : intl.formatMessage({ id: 'settings.apiKey.error.saveFailed' }),
      );
    } finally {
      setIsSavingKey(false);
    }
  }

  const placeholder = intl.formatMessage({
    id: apiKeyStored ? 'settings.apiKey.placeholder.update' : 'settings.apiKey.placeholder.new',
  });

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
        <FormattedMessage id="settings.apiKey.title" />
      </h3>

      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-300">
          <FormattedMessage id="settings.apiKey.description" />
        </p>
        {apiKeyStored && (
          <span className="text-xs text-green-400 flex items-center gap-1">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                clipRule="evenodd"
              />
            </svg>
            <FormattedMessage id="settings.apiKey.configured" />
          </span>
        )}
      </div>

      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
        disabled={isSavingKey}
      />

      <p className="text-xs text-slate-400">
        <FormattedMessage id="settings.apiKey.storageNote" />
      </p>

      {keyError && <ErrorBox>{keyError}</ErrorBox>}

      {keySuccess && (
        <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
          <FormattedMessage id="settings.apiKey.success" />
        </div>
      )}

      <button
        onClick={handleSaveApiKey}
        disabled={isSavingKey || !apiKey.trim()}
        className="w-full py-2 px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2"
      >
        {isSavingKey ? (
          <>
            <Spinner color="border-white" />
            <FormattedMessage id="settings.apiKey.saving" />
          </>
        ) : (
          <FormattedMessage id="settings.apiKey.save" />
        )}
      </button>

      <button
        type="button"
        onClick={() => setShowApiKeyHelp(!showApiKeyHelp)}
        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-300 transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${showApiKeyHelp ? 'rotate-90' : ''}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path
            fillRule="evenodd"
            d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
            clipRule="evenodd"
          />
        </svg>
        <FormattedMessage id="settings.apiKey.help.toggle" />
      </button>

      {showApiKeyHelp && (
        <div className="space-y-3">
          <div className="p-3 bg-slate-700/50 rounded-lg text-sm text-slate-300 space-y-2">
            <p className="font-medium">
              <FormattedMessage id="settings.apiKey.help.whyTitle" />
            </p>
            <p className="text-slate-400">
              <FormattedMessage id="settings.apiKey.help.whyBody" />
            </p>
          </div>

          <div className="p-3 bg-slate-700/50 rounded-lg text-sm space-y-3">
            <p className="font-medium text-slate-300">
              <FormattedMessage id="settings.apiKey.help.howTitle" />
            </p>
            <ol className="list-decimal list-inside space-y-1.5 text-slate-400">
              <li>
                <FormattedMessage
                  id="settings.apiKey.help.step1"
                  values={{
                    link: (
                      <a
                        href="https://console.anthropic.com/settings/keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-purple-400 hover:text-purple-300 underline"
                      >
                        console.anthropic.com/settings/keys
                      </a>
                    ),
                  }}
                />
              </li>
              <li><FormattedMessage id="settings.apiKey.help.step2" /></li>
              <li><FormattedMessage id="settings.apiKey.help.step3" /></li>
              <li><FormattedMessage id="settings.apiKey.help.step4" /></li>
              <li><FormattedMessage id="settings.apiKey.help.step5" /></li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
